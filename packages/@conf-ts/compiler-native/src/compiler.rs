use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

use crate::error::ConfTSError;
use crate::eval::{
  EvalContext, collect_imports, collect_macro_imports, evaluate, find_default_export,
};
use crate::resolver::{TsConfig, find_tsconfig, read_tsconfig, resolve_module};
use crate::types::{
  CompileOptions, FileContext, FileOwner, LineIndex, ParsedFile, ParsedProgram, TransformResult,
  Value, serialize_output,
};

#[derive(Debug, Clone, Default)]
pub struct SourceProject {
  pub files: HashMap<String, String>,
  pub resolutions: crate::browser::ProjectResolutions,
  pub compiler_options: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct SourceCompileInput {
  pub filename: String,
  pub code: String,
  pub project: Option<SourceProject>,
}

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
      if ret.panicked || ret.diagnostics.has_errors() {
        let diagnostic = ret.diagnostics.errors().next();
        let offset = diagnostic
          .and_then(|value| value.labels.as_slice().first())
          .map_or(0, |label| label.offset());
        let (line, character) = line_index.get_location(offset);
        let detail = diagnostic.map_or_else(
          || format!("Failed to parse file: {}", file_name),
          |value| {
            let mut detail = format!("Failed to parse file: {}", value.message);
            if let Some(help) = &value.help {
              detail.push_str(&format!("\nHelp: {}", help));
            }
            detail
          },
        );
        let mut error = ConfTSError::new(detail, file_name, line, character);
        error.add_source(file_name, &owner.source);
        return Err(error);
      }
      let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&ret.program);
      if let Some(diagnostic) = semantic.diagnostics.errors().next() {
        let offset = diagnostic
          .labels
          .as_slice()
          .first()
          .map_or(0, |label| label.offset());
        let (line, character) = line_index.get_location(offset);
        let mut detail = format!("Failed to parse file: {}", diagnostic.message);
        if let Some(help) = &diagnostic.help {
          detail.push_str(&format!("\nHelp: {}", help));
        }
        let mut error = ConfTSError::new(detail, file_name, line, character);
        error.add_source(file_name, &owner.source);
        return Err(error);
      }
      let scoping = semantic.semantic.into_scoping();
      Ok(ParsedProgram {
        program: ret.program,
        scoping,
      })
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
    if !body.len().is_multiple_of(2) {
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

fn load_file(
  file_path: &str,
  overrides: &HashMap<String, String>,
) -> Result<FileContext, ConfTSError> {
  let source = match overrides.get(file_path) {
    Some(text) => text.clone(),
    None => {
      let bytes = std::fs::read(file_path)
        .map_err(|e| ConfTSError::new(format!("Failed to read file: {}", e), file_path, 1, 1))?;
      decode_source(&bytes, file_path)?
    }
  };
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

/// A fully-loaded, resolved filesystem project ready for evaluation: every
/// reachable file starting from `entry_file`, plus the tsconfig used to
/// resolve them. Shared by the plain constants-only compile and by
/// @conf-ts/macro-transformer-native's macro pre-evaluation pass.
pub struct LoadedProgram {
  pub file_contexts: HashMap<String, FileContext>,
  pub entry_file: String,
  pub tsconfig_path: PathBuf,
  pub tsconfig_dir: PathBuf,
  pub tsconfig: TsConfig,
}

/// Load `input_file` and every file it (transitively) imports from the
/// filesystem, following tsconfig path-alias resolution.
pub fn load_file_program(input_file: &str) -> Result<LoadedProgram, ConfTSError> {
  load_file_program_with_overrides(input_file, &HashMap::new())
}

/// Same as `load_file_program`, but `overrides` (keyed by absolute file
/// path) is checked before falling back to the filesystem for each file's
/// source text — used to feed macro-transformed source back into the
/// ordinary constants-only pipeline via `compile_transformed`.
pub fn load_file_program_with_overrides(
  input_file: &str,
  overrides: &HashMap<String, String>,
) -> Result<LoadedProgram, ConfTSError> {
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

    let ctx = load_file(&file_path, overrides)?;
    for import_info in ctx.imports.values() {
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

  Ok(LoadedProgram {
    file_contexts,
    entry_file: abs_input_str,
    tsconfig_path,
    tsconfig_dir,
    tsconfig,
  })
}

/// Build an `EvalContext` for `loaded`, wiring up its module resolver and
/// eagerly collecting macro imports for every file (bookkeeping only —
/// compiler-native's own compile paths never set `macro_evaluator`, so this
/// map is only ever consulted by a downstream macro evaluator).
pub fn create_eval_context(loaded: &LoadedProgram) -> EvalContext {
  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = loaded.file_contexts.clone();

  let tsconfig_dir_clone = loaded.tsconfig_dir.clone();
  let tsconfig_for_resolver = loaded.tsconfig.clone();
  eval_ctx.resolver = Some(Box::new(move |specifier: &str, from_file: &str| {
    resolve_module(
      specifier,
      Path::new(from_file),
      &tsconfig_dir_clone,
      &tsconfig_for_resolver,
    )
    .map(|p| p.display().to_string())
  }));

  for (file_path, ctx) in &loaded.file_contexts {
    let imports = collect_macro_imports(ctx.program(), file_path);
    eval_ctx
      .macro_imports_map
      .insert(file_path.clone(), imports);
  }

  eval_ctx
}

/// Run the enum-collection pass over every file in `loaded`.
pub fn collect_enums_for_all(
  loaded: &LoadedProgram,
  eval_ctx: &mut EvalContext,
  options: &CompileOptions,
) {
  for (file_path, ctx) in &loaded.file_contexts {
    collect_enums(ctx.program(), file_path, eval_ctx, ctx, options);
  }
}

fn compile_loaded(
  loaded: &LoadedProgram,
  format: &str,
  options: &CompileOptions,
  extra_dependencies: &[String],
) -> Result<(String, Vec<String>), ConfTSError> {
  let mut eval_ctx = create_eval_context(loaded);
  collect_enums_for_all(loaded, &mut eval_ctx, options);

  let entry_ctx = loaded
    .file_contexts
    .get(&loaded.entry_file)
    .ok_or_else(|| {
      ConfTSError::new(
        format!("Entry file not found: {}", loaded.entry_file),
        &loaded.entry_file,
        1,
        1,
      )
    })?
    .clone();

  let output = find_default_export(&entry_ctx, &mut eval_ctx, options).map_err(|mut error| {
    for context in loaded.file_contexts.values() {
      error.add_source(&context.file_path, context.parsed.source());
    }
    error
  })?;

  eval_ctx
    .evaluated_files
    .insert(loaded.tsconfig_path.display().to_string());
  for dep in extra_dependencies {
    eval_ctx.evaluated_files.insert(dep.clone());
  }

  let file_names: Vec<String> = eval_ctx.evaluated_files.into_iter().collect();
  let serialized = serialize_output(&output, format)?;
  Ok((serialized, file_names))
}

/// Public compile function matching the TS API. Always constants-only —
/// compiler-native no longer evaluates macros itself; see
/// @conf-ts/macro-transformer-native for macro pre-evaluation.
pub fn compile(
  input_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let loaded = load_file_program(input_file)?;
  compile_loaded(&loaded, format, options, &[])
}

/// Compile an injected source payload, optionally backed by a source-project snapshot.
pub fn compile_source(
  input: &SourceCompileInput,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  if let Some(project) = &input.project {
    let mut project = project.clone();
    project
      .files
      .insert(input.filename.clone(), input.code.clone());
    return crate::browser::compile_project(
      &project.files,
      &input.filename,
      Some(&project.resolutions),
      project.compiler_options.as_ref(),
      format,
      options,
    );
  }

  let absolute = if Path::new(&input.filename).is_absolute() {
    PathBuf::from(&input.filename)
  } else {
    std::env::current_dir()
      .map_err(|error| {
        ConfTSError::new(
          format!("Failed to get CWD: {}", error),
          &input.filename,
          1,
          1,
        )
      })?
      .join(&input.filename)
  };
  let entry = absolute.display().to_string();
  let overrides = HashMap::from([(entry, input.code.clone())]);
  let loaded = load_file_program_with_overrides(&input.filename, &overrides)?;
  compile_loaded(&loaded, format, options, &[])
}

/// Compile an entry file given a pre-computed macro `TransformResult`
/// (`transformed.files` overrides the original source for whichever files
/// had macro calls rewritten to literal source).
pub fn compile_transformed(
  input_file: &str,
  format: &str,
  transformed: &TransformResult,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let loaded = load_file_program_with_overrides(input_file, &transformed.files)?;
  compile_loaded(&loaded, format, options, &transformed.dependencies)
}
