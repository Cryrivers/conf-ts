use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::compiler::{SourceCompileInput, SourceProject};
use crate::types::CompileOptions;

#[napi(object)]
pub struct CompileResult {
  pub output: String,
  pub dependencies: Vec<String>,
}

#[napi(object)]
pub struct JsCompileOptions {
  pub preserve_key_order: Option<bool>,
}

#[napi(object)]
pub struct JsSourceProject {
  pub files: HashMap<String, String>,
  pub resolutions: Option<HashMap<String, HashMap<String, String>>>,
  pub compiler_options: Option<serde_json::Value>,
}

#[napi(object)]
pub struct JsSourceCompileInput {
  pub filename: String,
  pub code: String,
  pub project: Option<JsSourceProject>,
}

#[napi(object)]
pub struct JsTsConfig {
  pub compiler_options: Option<serde_json::Value>,
}

fn convert_options(options: Option<JsCompileOptions>) -> CompileOptions {
  options.map_or_else(CompileOptions::default, |options| CompileOptions {
    preserve_key_order: options.preserve_key_order.unwrap_or(false),
    ..CompileOptions::default()
  })
}

fn convert_project(project: JsSourceProject) -> SourceProject {
  SourceProject {
    files: project.files,
    resolutions: project.resolutions.unwrap_or_default(),
    compiler_options: project.compiler_options,
  }
}

fn result(
  value: std::result::Result<(String, Vec<String>), crate::error::ConfTSError>,
) -> Result<CompileResult> {
  let (output, dependencies) =
    value.map_err(|error| Error::new(Status::GenericFailure, error.message))?;
  Ok(CompileResult {
    output,
    dependencies,
  })
}

/// Compile ordinary TypeScript source to JSON or YAML.
#[napi]
pub fn compile(
  input: Either<String, JsSourceCompileInput>,
  format: String,
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let options = convert_options(options);
  match input {
    Either::A(path) => result(crate::compiler::compile_path(&path, &format, &options)),
    Either::B(input) => result(crate::compiler::compile_source(
      &SourceCompileInput {
        filename: input.filename,
        code: input.code,
        project: input.project.map(convert_project),
      },
      &format,
      &options,
    )),
  }
}

/// Compile an in-memory ordinary TypeScript project.
#[napi]
pub fn compile_in_memory(
  files: HashMap<String, String>,
  entry_file: String,
  format: String,
  tsconfig: Option<JsTsConfig>,
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let project = SourceProject {
    files,
    resolutions: HashMap::new(),
    compiler_options: tsconfig.and_then(|value| value.compiler_options),
  };
  result(crate::browser::compile_project(
    &project.files,
    &entry_file,
    Some(&project.resolutions),
    project.compiler_options.as_ref(),
    &format,
    &convert_options(options),
  ))
}
