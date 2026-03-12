mod browser;
mod compiler;
mod error;
mod eval;
mod macro_eval;
mod resolver;
mod types;

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::types::CompileOptions;

#[napi(object)]
pub struct CompileResult {
  pub output: String,
  pub dependencies: Vec<String>,
}

#[napi(object)]
pub struct JsCompileOptions {
  pub preserve_key_order: Option<bool>,
  pub macro_mode: Option<bool>,
  pub env: Option<HashMap<String, String>>,
}

/// Compile a TypeScript config file to JSON or YAML.
#[napi]
pub fn compile(
  input_file: String,
  format: String,
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let opts = options
    .map(|o| CompileOptions {
      preserve_key_order: o.preserve_key_order.unwrap_or(false),
      macro_mode: o.macro_mode.unwrap_or(false),
      env: o.env,
    })
    .unwrap_or_default();

  let (output, dependencies) = compiler::compile(&input_file, &format, &opts)
    .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;

  Ok(CompileResult {
    output,
    dependencies,
  })
}

/// Compile from in-memory files.
#[napi]
pub fn compile_in_memory(
  files: HashMap<String, String>,
  entry_file: String,
  format: String,
  macro_mode: bool,
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let opts = options
    .map(|o| CompileOptions {
      preserve_key_order: o.preserve_key_order.unwrap_or(false),
      macro_mode: o.macro_mode.unwrap_or(false) || macro_mode,
      env: o.env,
    })
    .unwrap_or(CompileOptions {
      macro_mode,
      ..Default::default()
    });

  let (output, dependencies) =
    browser::compile_in_memory(&files, &entry_file, &format, macro_mode, &opts)
      .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;

  Ok(CompileResult {
    output,
    dependencies,
  })
}
