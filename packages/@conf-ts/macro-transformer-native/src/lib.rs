mod transform;

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use transform::{
  ProjectSnapshot, QuoteStyle, TransformInput, TransformOptions, TransformProjectInput,
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

#[napi(object)]
pub struct JsTransformInput {
  pub filename: String,
  pub code: String,
  pub project: Option<JsProjectSnapshot>,
}

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
    entry_files: value.entry_files.unwrap_or_default(),
    dependencies: value.dependencies.unwrap_or_default(),
  }
}

fn options(value: Option<JsTransformOptions>) -> Result<TransformOptions> {
  let value = value.unwrap_or(JsTransformOptions {
    env: None,
    quote: None,
    preserve_key_order: None,
    source_map: None,
    inherit_process_env: None,
  });
  Ok(TransformOptions {
    env: value.env.unwrap_or_default(),
    quote: quote(value.quote)?,
    preserve_key_order: value.preserve_key_order.unwrap_or(false),
    source_map: value.source_map.unwrap_or(false),
    inherit_process_env: value.inherit_process_env.unwrap_or(true),
  })
}

/// Transform a project with one shared native analysis pass.
#[napi]
pub fn transform_project(
  input: JsTransformProjectInput,
  transform_options: Option<JsTransformOptions>,
) -> Result<TransformProjectResult> {
  let output = transform_project_inner(
    TransformProjectInput {
      project: project(input.project),
      files: input.files,
    },
    options(transform_options)?,
  )
  .map_err(|error| Error::new(Status::GenericFailure, error.message))?;
  Ok(TransformProjectResult {
    transformed: output
      .transformed
      .into_iter()
      .map(|(filename, result)| {
        (
          filename,
          TransformResult {
            code: result.code,
            map: result.map.unwrap_or(serde_json::Value::Null),
            dependencies: result.dependencies,
          },
        )
      })
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
    TransformInput {
      filename: input.filename,
      code: input.code,
      project: input.project.map(project),
    },
    options(transform_options)?,
  )
  .map_err(|error| Error::new(Status::GenericFailure, error.message))?;
  Ok(TransformResult {
    code: output.code,
    map: output.map.unwrap_or(serde_json::Value::Null),
    dependencies: output.dependencies,
  })
}
