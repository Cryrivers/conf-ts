use std::collections::HashMap;

use crate::compiler::{collect_enums, parse_ts_file};
use crate::error::ConfTSError;
use crate::eval::{EvalContext, collect_imports, find_default_export};
use crate::resolver::{TsCompilerOptions, resolve_module_in_memory_with_options};
use crate::types::{CompileOptions, FileContext, serialize_output};

pub type ProjectResolutions = HashMap<String, HashMap<String, String>>;

/// Parse every supported source file into a self-owned Oxc file context.
pub fn build_file_contexts(
  files: &HashMap<String, String>,
) -> Result<HashMap<String, FileContext>, ConfTSError> {
  let mut file_contexts = HashMap::new();
  for (file_name, source) in files {
    if !matches!(
      file_name.rsplit('.').next(),
      Some("ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs")
    ) {
      continue;
    }
    let (parsed, line_index) = parse_ts_file(source, file_name)?;
    let imports = collect_imports(parsed.program());
    file_contexts.insert(
      file_name.clone(),
      FileContext {
        file_path: file_name.clone(),
        parsed,
        line_index,
        imports,
      },
    );
  }
  Ok(file_contexts)
}

/// Compile a source project without reading the filesystem.
pub fn compile_project(
  files: &HashMap<String, String>,
  entry_file: &str,
  resolutions: Option<&ProjectResolutions>,
  compiler_options: Option<&serde_json::Value>,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let file_contexts = build_file_contexts(files)?;
  let entry = file_contexts.get(entry_file).cloned().ok_or_else(|| {
    ConfTSError::new(
      format!("Entry file not found: {}", entry_file),
      entry_file,
      1,
      1,
    )
  })?;

  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = file_contexts.clone();

  let project_files = files.clone();
  let project_resolutions = resolutions.cloned().unwrap_or_default();
  let project_compiler_options = compiler_options
    .cloned()
    .and_then(|value| serde_json::from_value::<TsCompilerOptions>(value).ok());
  eval_ctx.resolver = Some(Box::new(move |specifier, from_file| {
    project_resolutions
      .get(from_file)
      .and_then(|table| table.get(specifier))
      .cloned()
      .or_else(|| {
        resolve_module_in_memory_with_options(
          specifier,
          from_file,
          &project_files,
          project_compiler_options.as_ref(),
        )
      })
  }));

  for (file_path, context) in &file_contexts {
    collect_enums(
      context.program(),
      file_path,
      &mut eval_ctx,
      context,
      options,
    );
  }

  let output = find_default_export(&entry, &mut eval_ctx, options).map_err(|mut error| {
    for context in file_contexts.values() {
      error.add_source(&context.file_path, context.parsed.source());
    }
    error
  })?;
  let mut dependencies: Vec<String> = eval_ctx.evaluated_files.into_iter().collect();
  dependencies.sort();
  dependencies.dedup();
  Ok((serialize_output(&output, format)?, dependencies))
}

/// Backwards-compatible in-memory Rust entry point.
pub fn compile_in_memory(
  files: &HashMap<String, String>,
  entry_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  compile_project(files, entry_file, None, None, format, options)
}
