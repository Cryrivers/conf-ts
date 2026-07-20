mod snapshot;
mod transform;

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use snapshot::{
  MacroProjectSnapshot, SnapshotOptions, create_project_snapshot,
  scan_referenced_modules as scan_referenced_modules_inner,
};
use transform::{
  ProjectSnapshot, QuoteStyle, TransformOptions, TransformOutput,
  transform_project as transform_project_inner, transform_source,
};

#[napi(object)]
pub struct JsProjectSnapshot {
  pub files: HashMap<String, String>,
  pub resolutions: Option<HashMap<String, HashMap<String, String>>>,
  pub compiler_options: Option<serde_json::Value>,
  pub entry_files: Option<Vec<String>>,
  pub dependencies: Option<Vec<String>>,
  pub referenced_modules: Option<HashMap<String, Vec<String>>>,
  pub missing_dependencies: Option<Vec<String>>,
}

#[derive(Default)]
#[napi(object)]
pub struct JsMacroProjectSnapshotOptions {
  pub compiler_options: Option<serde_json::Value>,
  pub previous: Option<JsProjectSnapshot>,
  pub overrides: Option<HashMap<String, String>>,
}

#[napi(object)]
pub struct JsTransformInput {
  pub filename: String,
  pub code: String,
  pub project: Option<JsProjectSnapshot>,
}

#[derive(Default)]
#[napi(object)]
pub struct JsTransformOptions {
  pub env: Option<HashMap<String, String>>,
  pub inherit_process_env: Option<bool>,
  #[napi(ts_type = "'single' | 'double'")]
  pub quote: Option<String>,
  pub preserve_key_order: Option<bool>,
  pub source_map: Option<bool>,
}

#[napi(object)]
pub struct TransformResult {
  pub code: String,
  #[napi(ts_type = "Record<string, any> | null")]
  pub map: serde_json::Value,
  pub dependencies: Vec<String>,
}

#[napi(object)]
pub struct JsTransformProjectInput {
  pub project: JsProjectSnapshot,
  pub files: Option<Vec<String>>,
}

#[napi(object)]
pub struct TransformProjectResult {
  pub transformed: HashMap<String, TransformResult>,
  pub dependencies: Vec<String>,
}

fn quote(value: Option<String>) -> Result<QuoteStyle> {
  match value.as_deref() {
    None | Some("double") => Ok(QuoteStyle::Double),
    Some("single") => Ok(QuoteStyle::Single),
    Some(_) => Err(Error::new(
      Status::InvalidArg,
      "Invalid option: quote must be 'single' or 'double'",
    )),
  }
}

fn project(value: JsProjectSnapshot) -> ProjectSnapshot {
  ProjectSnapshot {
    files: value.files,
    resolutions: value.resolutions.unwrap_or_default(),
    compiler_options: value.compiler_options,
    dependencies: value.dependencies.unwrap_or_default(),
  }
}

fn macro_project(value: JsProjectSnapshot) -> MacroProjectSnapshot {
  MacroProjectSnapshot {
    files: value.files,
    resolutions: value.resolutions.unwrap_or_default(),
    compiler_options: value.compiler_options,
    entry_files: value.entry_files.unwrap_or_default(),
    dependencies: value.dependencies.unwrap_or_default(),
    referenced_modules: value.referenced_modules.unwrap_or_default(),
    missing_dependencies: value.missing_dependencies.unwrap_or_default(),
  }
}

fn js_project(value: MacroProjectSnapshot) -> JsProjectSnapshot {
  JsProjectSnapshot {
    files: value.files,
    resolutions: Some(value.resolutions),
    compiler_options: value.compiler_options,
    entry_files: Some(value.entry_files),
    dependencies: Some(value.dependencies),
    referenced_modules: Some(value.referenced_modules),
    missing_dependencies: Some(value.missing_dependencies),
  }
}

fn js_result(value: TransformOutput) -> TransformResult {
  TransformResult {
    code: value.code,
    map: value.map.unwrap_or(serde_json::Value::Null),
    dependencies: value.dependencies,
  }
}

fn options(value: Option<JsTransformOptions>) -> Result<TransformOptions> {
  let value = value.unwrap_or_default();
  Ok(TransformOptions {
    env: value.env.unwrap_or_default(),
    quote: quote(value.quote)?,
    preserve_key_order: value.preserve_key_order.unwrap_or(false),
    source_map: value.source_map.unwrap_or(false),
    inherit_process_env: value.inherit_process_env.unwrap_or(true),
  })
}

/// Capture a filesystem-backed TypeScript project without loading TypeScript.
#[napi]
pub fn create_macro_project_snapshot(
  entry_files: Vec<String>,
  snapshot_options: Option<JsMacroProjectSnapshotOptions>,
) -> Result<JsProjectSnapshot> {
  let value = snapshot_options.unwrap_or_default();
  create_project_snapshot(
    entry_files,
    SnapshotOptions {
      compiler_options: value.compiler_options,
      previous: value.previous.map(macro_project),
      overrides: value.overrides.unwrap_or_default(),
    },
  )
  .map(js_project)
  .map_err(|error| Error::new(Status::GenericFailure, error.message))
}

/// Return static import/export specifiers for a set of source overrides.
#[napi]
pub fn scan_referenced_modules(
  files: HashMap<String, String>,
) -> Result<HashMap<String, Vec<String>>> {
  scan_referenced_modules_inner(&files)
    .map_err(|error| Error::new(Status::GenericFailure, error.message))
}

/// Transform a project with one shared native analysis pass.
#[napi]
pub fn transform_project(
  input: JsTransformProjectInput,
  transform_options: Option<JsTransformOptions>,
) -> Result<TransformProjectResult> {
  let output = transform_project_inner(
    project(input.project),
    input.files,
    options(transform_options)?,
  )
  .map_err(|error| Error::new(Status::GenericFailure, error.message))?;
  Ok(TransformProjectResult {
    transformed: output
      .transformed
      .into_iter()
      .map(|(filename, value)| (filename, js_result(value)))
      .collect(),
    dependencies: output.dependencies,
  })
}

/// Evaluate @conf-ts/macro calls and return ordinary TypeScript source.
#[napi]
pub fn transform(
  input: JsTransformInput,
  transform_options: Option<JsTransformOptions>,
) -> Result<TransformResult> {
  let output = transform_source(
    input.filename,
    input.code,
    input.project.map(project),
    options(transform_options)?,
  )
  .map_err(|error| Error::new(Status::GenericFailure, error.message))?;
  Ok(js_result(output))
}
