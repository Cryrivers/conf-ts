use std::collections::{HashMap, HashSet};
use std::path::Path;

use swc_common::{FileName, SourceMap, sync::Lrc};
use swc_ecma_ast::*;
use swc_ecma_parser::{Syntax, TsSyntax, parse_file_as_module};

use crate::error::ConfTSError;
use crate::eval::{EvalContext, collect_imports, collect_macro_imports, evaluate};
use crate::resolver::{find_tsconfig, read_tsconfig, resolve_module};
use crate::types::{CompileOptions, FileContext, Value, replace_raw_number_markers};

/// Parse a TypeScript source file into a Module AST.
pub fn parse_ts_file(
  source: &str,
  file_name: &str,
  source_map: &Lrc<SourceMap>,
) -> Result<Module, ConfTSError> {
  let fm = source_map.new_source_file(
    Lrc::new(FileName::Real(file_name.into())),
    source.to_string(),
  );
  let syntax = Syntax::Typescript(TsSyntax {
    tsx: file_name.ends_with(".tsx"),
    decorators: true,
    ..Default::default()
  });
  let mut errors = Vec::new();
  let module = parse_file_as_module(&fm, syntax, EsVersion::Es2020, None, &mut errors);

  match module {
    Ok(m) => Ok(m),
    Err(_) => Err(ConfTSError::new(
      format!("Failed to parse file: {}", file_name),
      file_name,
      1,
      1,
    )),
  }
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

fn load_file(file_path: &str, source_map: &Lrc<SourceMap>) -> Result<FileContext, ConfTSError> {
  let bytes = std::fs::read(file_path)
    .map_err(|e| ConfTSError::new(format!("Failed to read file: {}", e), file_path, 1, 1))?;
  let source = decode_source(&bytes, file_path)?;
  let module = parse_ts_file(&source, file_path, source_map)?;
  let imports = collect_imports(&module);
  Ok(FileContext {
    file_path: file_path.to_string(),
    module,
    source_map: source_map.clone(),
    imports,
  })
}

/// Collect enum values from a module.
fn collect_enums(
  module: &Module,
  file_path: &str,
  ctx: &mut EvalContext,
  file_ctx: &FileContext,
  options: &CompileOptions,
) {
  for item in &module.body {
    let decl = match item {
      ModuleItem::Stmt(Stmt::Decl(Decl::TsEnum(e))) => Some(e.as_ref()),
      ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
        if let Decl::TsEnum(e) = &export.decl {
          Some(e.as_ref())
        } else {
          None
        }
      }
      _ => None,
    };

    if let Some(enum_decl) = decl {
      let enum_name = enum_decl.id.sym.as_str();
      let mut next_enum_value: i64 = 0;
      let mut local_context: HashMap<String, Value> = HashMap::new();

      for member in &enum_decl.members {
        let member_name = match &member.id {
          TsEnumMemberId::Ident(ident) => ident.sym.as_str().to_string(),
          TsEnumMemberId::Str(s) => s.value.as_str().unwrap_or("").to_string(),
        };
        let full_name = format!("{}.{}", enum_name, member_name);

        let val = if let Some(ref init) = member.init {
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

  let source_map: Lrc<SourceMap> = Lrc::new(SourceMap::default());

  // Load all reachable files
  let mut file_contexts: HashMap<String, FileContext> = HashMap::new();
  let mut files_to_load = vec![abs_input_str.clone()];
  let mut loaded = HashSet::new();

  while let Some(file_path) = files_to_load.pop() {
    if loaded.contains(&file_path) {
      continue;
    }
    loaded.insert(file_path.clone());

    let ctx = load_file(&file_path, &source_map)?;
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
  let tsconfig_clone = tsconfig;
  eval_ctx.resolver = Some(Box::new(move |specifier: &str, from_file: &str| {
    resolve_module(
      specifier,
      Path::new(from_file),
      &tsconfig_dir_clone,
      &tsconfig_clone,
    )
    .map(|p| p.display().to_string())
  }));

  // Collect macro imports
  for (file_path, ctx) in &file_contexts {
    let imports = collect_macro_imports(&ctx.module, file_path);
    eval_ctx
      .macro_imports_map
      .insert(file_path.clone(), imports);
  }

  // Collect enums from all files
  let file_paths: Vec<String> = file_contexts.keys().cloned().collect();
  for file_path in &file_paths {
    let ctx = file_contexts.get(file_path).unwrap().clone();
    collect_enums(
      &ctx.module,
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

  let mut found_default = false;
  let mut output = Value::Null;

  for item in &entry_ctx.module.body {
    if let ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(export)) = item {
      output = evaluate(
        &export.expr,
        &entry_ctx,
        &mut eval_ctx,
        None,
        &options_with_macro,
      )?;
      found_default = true;
      break;
    }
  }

  if !found_default {
    return Err(ConfTSError::new(
      format!(
        "No default export found in the entry file: {}",
        abs_input_str
      ),
      &abs_input_str,
      1,
      1,
    ));
  }

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

  match format {
    "json" => {
      let json_value = output.to_json();
      let json_str = serde_json::to_string_pretty(&json_value).map_err(|e| {
        ConfTSError::new(format!("Failed to serialize JSON: {}", e), "unknown", 1, 1)
      })?;
      Ok((replace_raw_number_markers(&json_str), file_names))
    }
    "yaml" => {
      let yaml_value = output.to_yaml();
      let yaml_str = serde_yaml::to_string(&yaml_value).map_err(|e| {
        ConfTSError::new(format!("Failed to serialize YAML: {}", e), "unknown", 1, 1)
      })?;

      // Post-process to match JS compiler (yaml-library) format:
      // 1. Remove leading --- and newline
      let processed = yaml_str
        .strip_prefix("---\n")
        .unwrap_or(&yaml_str)
        .to_string();

      // 2. Adjust array item indentation and quotes
      let mut processed_lines = String::new();
      for line in processed.lines() {
        let mut new_line = line.to_string();
        // Convert single quotes to double quotes (heuristic for strings)
        // For simple key: 'value' or - 'value'
        if (new_line.contains(": '") || new_line.contains("- '")) && new_line.ends_with('\'') {
          new_line = new_line.replace('\'', "\"");
        }
        processed_lines.push_str(&new_line);
        processed_lines.push_str("\n");
      }

      Ok((replace_raw_number_markers(&processed_lines), file_names))
    }
    _ => Err(ConfTSError::new(
      format!("Unsupported format: {}", format),
      "unknown",
      1,
      1,
    )),
  }
}
