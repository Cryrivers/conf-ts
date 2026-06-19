use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::rc::Rc;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_span::SourceType;

use crate::error::ConfTSError;
use crate::eval::{
  EvalContext, collect_imports, collect_macro_imports, evaluate, find_default_export,
};
use crate::resolver::{find_tsconfig, read_tsconfig, resolve_module};
use crate::types::{
  CompileOptions, FileContext, FileOwner, LineIndex, ParsedFile, ParsedProgram, Value,
  serialize_output,
};

/// Parse a TypeScript source file into a ParsedFile + LineIndex.
pub fn parse_ts_file(
  source: &str,
  file_name: &str,
) -> Result<(Rc<ParsedFile>, LineIndex), ConfTSError> {
  let line_index = LineIndex::new(source);
  let source_type = SourceType::from_path(file_name).unwrap_or_default();
  let parsed = ParsedFile::try_new(
    FileOwner {
      allocator: Allocator::default(),
      source: source.to_string(),
    },
    |owner| {
      let ret = Parser::new(&owner.allocator, &owner.source, source_type).parse();
      if ret.panicked {
        Err(ConfTSError::new(
          format!("Failed to parse file: {}", file_name),
          file_name,
          1,
          1,
        ))
      } else {
        Ok(ParsedProgram {
          program: ret.program,
        })
      }
    },
  )?;
  Ok((Rc::new(parsed), line_index))
}

fn decode_source(bytes: &[u8], file_path: &str) -> Result<String, ConfTSError> {
  if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
    return String::from_utf8(bytes[3..].to_vec())
      .map_err(|e| ConfTSError::new(format!("Failed to decode UTF-8: {}", e), file_path, 1, 1));
  }
  if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
    let is_le = bytes.starts_with(&[0xFF, 0xFE]);
    let body = &bytes[2..];
    if body.len() % 2 != 0 {
      return Err(ConfTSError::new(
        "Failed to decode UTF-16: odd byte length",
        file_path,
        1,
        1,
      ));
    }
    let mut units = Vec::with_capacity(body.len() / 2);
    for chunk in body.chunks_exact(2) {
      let unit = if is_le {
        u16::from_le_bytes([chunk[0], chunk[1]])
      } else {
        u16::from_be_bytes([chunk[0], chunk[1]])
      };
      units.push(unit);
    }
    return String::from_utf16(&units)
      .map_err(|e| ConfTSError::new(format!("Failed to decode UTF-16: {}", e), file_path, 1, 1));
  }
  String::from_utf8(bytes.to_vec()).map_err(|e| {
    ConfTSError::new(
      format!("Failed to decode file as UTF-8 or UTF-16: {}", e),
      file_path,
      1,
      1,
    )
  })
}

fn load_file(file_path: &str) -> Result<FileContext, ConfTSError> {
  let bytes = std::fs::read(file_path)
    .map_err(|e| ConfTSError::new(format!("Failed to read file: {}", e), file_path, 1, 1))?;
  let source = decode_source(&bytes, file_path)?;
  let (parsed, line_index) = parse_ts_file(&source, file_path)?;
  let imports = collect_imports(parsed.program());
  Ok(FileContext {
    file_path: file_path.to_string(),
    parsed,
    line_index,
    imports,
  })
}

/// Collect enum values from a program.
pub fn collect_enums(
  program: &Program,
  file_path: &str,
  ctx: &mut EvalContext,
  file_ctx: &FileContext,
  options: &CompileOptions,
) {
  for stmt in &program.body {
    let decl = match stmt {
      Statement::TSEnumDeclaration(e) => Some(e.as_ref()),
      Statement::ExportNamedDeclaration(export) => {
        if let Some(Declaration::TSEnumDeclaration(e)) = &export.declaration {
          Some(e.as_ref())
        } else {
          None
        }
      }
      _ => None,
    };

    if let Some(enum_decl) = decl {
      let enum_name = enum_decl.id.name.as_str();
      let mut next_enum_value: i64 = 0;
      let mut local_context: HashMap<String, Value> = HashMap::new();
      for member in &enum_decl.body.members {
        let member_name = match &member.id {
          TSEnumMemberName::Identifier(ident) => ident.name.as_str().to_string(),
          TSEnumMemberName::String(s) => s.value.as_str().to_string(),
          _ => continue,
        };
        let full_name = format!("{}.{}", enum_name, member_name);

        let val = if let Some(ref init) = member.initializer {
          let mut enum_eval_files = HashSet::new();
          std::mem::swap(&mut ctx.evaluated_files, &mut enum_eval_files);
          let res = match evaluate(init, file_ctx, ctx, Some(&local_context), options) {
            Ok(v) => v,
            Err(_) => Value::number(next_enum_value as f64),
          };
          std::mem::swap(&mut ctx.evaluated_files, &mut enum_eval_files);
          res
        } else {
          Value::number(next_enum_value as f64)
        };

        if let Value::Number(n) = &val {
          next_enum_value = n.value as i64 + 1;
        } else {
          next_enum_value += 1;
        }

        local_context.insert(member_name.clone(), val.clone());
        ctx
          .enum_map
          .entry(file_path.to_string())
          .or_default()
          .insert(full_name, val);
      }
    }
  }
}

/// Internal compile function.
fn _compile(
  input_file: &str,
  macro_mode: bool,
  options: &CompileOptions,
) -> Result<(Value, HashSet<String>), ConfTSError> {
  let input_path = Path::new(input_file);
  let abs_input = if input_path.is_absolute() {
    input_path.to_path_buf()
  } else {
    std::env::current_dir()
      .map_err(|e| ConfTSError::new(format!("Failed to get CWD: {}", e), input_file, 1, 1))?
      .join(input_path)
  };
  let abs_input_str = abs_input.display().to_string();

  let tsconfig_path = find_tsconfig(&abs_input).ok_or_else(|| {
    ConfTSError::new("Could not find a tsconfig.json file.", &abs_input_str, 1, 1)
  })?;
  let tsconfig = read_tsconfig(&tsconfig_path)?;
  let tsconfig_dir = tsconfig_path.parent().unwrap().to_path_buf();

  // Load all reachable files
  let mut file_contexts: HashMap<String, FileContext> = HashMap::new();
  let mut files_to_load = vec![abs_input_str.clone()];
  let mut loaded = HashSet::new();

  while let Some(file_path) = files_to_load.pop() {
    if loaded.contains(&file_path) {
      continue;
    }
    loaded.insert(file_path.clone());

    let ctx = load_file(&file_path)?;
    for (_, import_info) in &ctx.imports {
      if let Some(resolved) = resolve_module(
        &import_info.source,
        Path::new(&file_path),
        &tsconfig_dir,
        &tsconfig,
      ) {
        let resolved_str = resolved.display().to_string();
        if !loaded.contains(&resolved_str) {
          files_to_load.push(resolved_str);
        }
      }
    }
    file_contexts.insert(file_path, ctx);
  }

  let mut options_with_macro = options.clone();
  options_with_macro.macro_mode = macro_mode;

  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = file_contexts.clone();

  // Set up resolver closure
  let tsconfig_dir_clone = tsconfig_dir.clone();
  let tsconfig_for_resolver = tsconfig.clone();
  eval_ctx.resolver = Some(Box::new(move |specifier: &str, from_file: &str| {
    resolve_module(
      specifier,
      Path::new(from_file),
      &tsconfig_dir_clone,
      &tsconfig_for_resolver,
    )
    .map(|p| p.display().to_string())
  }));

  // Collect macro imports
  for (file_path, ctx) in &file_contexts {
    let imports = collect_macro_imports(ctx.program(), file_path);
    eval_ctx
      .macro_imports_map
      .insert(file_path.clone(), imports);
  }

  // Collect enums from all files
  let file_paths: Vec<String> = file_contexts.keys().cloned().collect();
  for file_path in &file_paths {
    let ctx = file_contexts.get(file_path).unwrap().clone();
    collect_enums(
      ctx.program(),
      file_path,
      &mut eval_ctx,
      &ctx,
      &options_with_macro,
    );
  }

  // Evaluate default export from entry file
  let entry_ctx = file_contexts
    .get(&abs_input_str)
    .ok_or_else(|| {
      ConfTSError::new(
        format!("Entry file not found: {}", abs_input_str),
        &abs_input_str,
        1,
        1,
      )
    })?
    .clone();

  let output = find_default_export(&entry_ctx, &mut eval_ctx, &options_with_macro)?;

  eval_ctx
    .evaluated_files
    .insert(tsconfig_path.display().to_string());
  Ok((output, eval_ctx.evaluated_files))
}

/// Public compile function matching the TS API.
pub fn compile(
  input_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let (output, evaluated_files) = _compile(input_file, options.macro_mode, options)?;
  let file_names: Vec<String> = evaluated_files.into_iter().collect();
  let serialized = serialize_output(&output, format)?;
  Ok((serialized, file_names))
}
