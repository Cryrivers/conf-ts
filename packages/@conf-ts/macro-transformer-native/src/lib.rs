mod macro_eval;
mod transform;

use std::collections::HashMap;

use compiler_native::types::{
  CompileOptions, JsxOutputField, JsxOutputOptions as NativeJsxOutputOptions, QuoteStyle,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct CompileResult {
  pub output: String,
  pub dependencies: Vec<String>,
}

#[napi(object)]
pub struct TransformResult {
  pub files: HashMap<String, String>,
  pub dependencies: Vec<String>,
}

#[napi(object)]
pub struct JsxOutputOptions {
  #[napi(js_name = "type")]
  pub type_name: Option<String>,
  pub props: Option<Either<String, bool>>,
  pub children: Option<Either<String, bool>>,
  pub key: Option<String>,
  pub fragment: Option<String>,
  #[napi(js_name = "typeFormat", ts_type = "'string' | 'descriptor'")]
  pub type_format: Option<String>,
}

#[napi(object)]
pub struct JsCompileOptions {
  pub preserve_key_order: Option<bool>,
  pub jsx: Option<bool>,
  pub env: Option<HashMap<String, String>>,
  pub jsx_output: Option<JsxOutputOptions>,
  #[napi(ts_type = "'single' | 'double'")]
  pub quote: Option<String>,
}

fn convert_jsx_field(value: Option<Either<String, bool>>) -> Option<JsxOutputField> {
  match value {
    Some(Either::A(name)) => Some(JsxOutputField::Name(name)),
    Some(Either::B(false)) => Some(JsxOutputField::Disabled),
    Some(Either::B(true)) => Some(JsxOutputField::InvalidBool),
    None => None,
  }
}

fn convert_jsx_output(value: Option<JsxOutputOptions>) -> Option<NativeJsxOutputOptions> {
  value.map(|o| NativeJsxOutputOptions {
    type_name: o.type_name,
    props: convert_jsx_field(o.props),
    children: convert_jsx_field(o.children),
    key: o.key,
    fragment: o.fragment,
    type_format: o.type_format,
  })
}

fn parse_quote(value: Option<String>) -> Result<QuoteStyle> {
  match value.as_deref() {
    None | Some("double") => Ok(QuoteStyle::Double),
    Some("single") => Ok(QuoteStyle::Single),
    _ => Err(Error::new(
      Status::GenericFailure,
      "Invalid option: quote must be 'single' or 'double'",
    )),
  }
}

fn convert_options(options: Option<JsCompileOptions>) -> Result<CompileOptions> {
  match options {
    Some(o) => Ok(CompileOptions {
      preserve_key_order: o.preserve_key_order.unwrap_or(false),
      jsx: o.jsx,
      env: o.env,
      jsx_output: convert_jsx_output(o.jsx_output),
      quote: parse_quote(o.quote)?,
    }),
    None => Ok(CompileOptions::default()),
  }
}

fn to_js_transform_result(result: compiler_native::types::TransformResult) -> TransformResult {
  TransformResult {
    files: result.files,
    dependencies: result.dependencies,
  }
}

/// Pre-evaluate macros in a filesystem project using the oxc API.
#[napi]
pub fn transform_macros(
  input_file: String,
  options: Option<JsCompileOptions>,
) -> Result<TransformResult> {
  let opts = convert_options(options)?;
  let result = transform::transform_macros(&input_file, &opts)
    .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;
  Ok(to_js_transform_result(result))
}

/// Pre-evaluate macros in an in-memory oxc project.
#[napi]
pub fn transform_macros_in_memory(
  files: HashMap<String, String>,
  entry_file: String,
  options: Option<JsCompileOptions>,
) -> Result<TransformResult> {
  let opts = convert_options(options)?;
  let result = transform::transform_macros_in_memory(&files, &entry_file, &opts)
    .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;
  Ok(to_js_transform_result(result))
}

/// Pre-evaluate macros then compile a TypeScript config file to JSON/YAML.
#[napi]
pub fn compile(
  input_file: String,
  format: String,
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let opts = convert_options(options)?;
  let transformed = transform::transform_macros(&input_file, &opts)
    .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;
  let (output, dependencies) =
    compiler_native::compiler::compile_transformed(&input_file, &format, &transformed, &opts)
      .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;
  Ok(CompileResult {
    output,
    dependencies,
  })
}

/// Pre-evaluate macros then compile from in-memory files to JSON/YAML.
#[napi]
pub fn compile_in_memory(
  files: HashMap<String, String>,
  entry_file: String,
  format: String,
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let opts = convert_options(options)?;
  let transformed = transform::transform_macros_in_memory(&files, &entry_file, &opts)
    .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;
  let (output, dependencies) = compiler_native::browser::compile_in_memory_transformed(
    &files,
    &entry_file,
    &format,
    &transformed,
    &opts,
  )
  .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;
  Ok(CompileResult {
    output,
    dependencies,
  })
}
