use std::collections::HashMap;

use crate::compiler::{collect_enums, parse_ts_file};
use crate::error::ConfTSError;
use crate::eval::{EvalContext, collect_imports, collect_macro_imports, find_default_export};
use crate::resolver::resolve_module_in_memory;
use crate::types::{CompileOptions, FileContext, TransformResult, serialize_output};

/// Parse every `.ts`/`.tsx`/`.js`/`.jsx` file in `files` into a `FileContext`.
/// Shared with @conf-ts/macro-transformer-native's in-memory transform path.
pub fn build_file_contexts(
  files: &HashMap<String, String>,
) -> Result<HashMap<String, FileContext>, ConfTSError> {
  let mut file_contexts: HashMap<String, FileContext> = HashMap::new();
  for (file_name, source) in files {
    if file_name.ends_with(".ts")
      || file_name.ends_with(".tsx")
      || file_name.ends_with(".js")
      || file_name.ends_with(".jsx")
    {
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
  }
  Ok(file_contexts)
}

/// Build an `EvalContext` for an in-memory file set, wiring up the
/// in-memory module resolver and eagerly collecting macro imports. Shared
/// with @conf-ts/macro-transformer-native's in-memory transform path.
pub fn create_in_memory_eval_context(
  files: &HashMap<String, String>,
  file_contexts: &HashMap<String, FileContext>,
) -> EvalContext {
  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = file_contexts.clone();

  let files_clone = files.clone();
  eval_ctx.resolver = Some(Box::new(move |specifier: &str, from_file: &str| {
    resolve_module_in_memory(specifier, from_file, &files_clone)
  }));

  for (file_path, ctx) in file_contexts {
    let imports = collect_macro_imports(ctx.program(), file_path);
    eval_ctx
      .macro_imports_map
      .insert(file_path.clone(), imports);
  }

  eval_ctx
}

fn compile_in_memory_impl(
  files: &HashMap<String, String>,
  entry_file: &str,
  format: &str,
  options: &CompileOptions,
  extra_dependencies: &[String],
) -> Result<(String, Vec<String>), ConfTSError> {
  let file_contexts = build_file_contexts(files)?;
  let mut eval_ctx = create_in_memory_eval_context(files, &file_contexts);

  let file_paths: Vec<String> = file_contexts.keys().cloned().collect();
  for file_path in &file_paths {
    let ctx = file_contexts.get(file_path).unwrap().clone();
    collect_enums(ctx.program(), file_path, &mut eval_ctx, &ctx, options);
  }

  let entry_ctx = file_contexts
    .get(entry_file)
    .ok_or_else(|| {
      ConfTSError::new(
        format!("Entry file not found: {}", entry_file),
        entry_file,
        1,
        1,
      )
    })?
    .clone();

  let output = find_default_export(&entry_ctx, &mut eval_ctx, options)?;

  for dep in extra_dependencies {
    eval_ctx.evaluated_files.insert(dep.clone());
  }

  let file_names: Vec<String> = eval_ctx.evaluated_files.into_iter().collect();
  let serialized = serialize_output(&output, format)?;
  Ok((serialized, file_names))
}

/// Compile from in-memory files (browser mode). Always constants-only — see
/// `compile_in_memory_transformed` for the macro pre-evaluation pipeline.
pub fn compile_in_memory(
  files: &HashMap<String, String>,
  entry_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  compile_in_memory_impl(files, entry_file, format, options, &[])
}

/// In-memory counterpart to `compiler::compile_transformed`: `transformed.files`
/// is merged over `files` before building the program, then the ordinary
/// constants-only pass runs.
pub fn compile_in_memory_transformed(
  files: &HashMap<String, String>,
  entry_file: &str,
  format: &str,
  transformed: &TransformResult,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let mut merged = files.clone();
  merged.extend(transformed.files.clone());
  compile_in_memory_impl(
    &merged,
    entry_file,
    format,
    options,
    &transformed.dependencies,
  )
}
