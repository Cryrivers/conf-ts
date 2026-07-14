use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::types::{
  CompileOptions, JsxOutputField, JsxOutputOptions as NativeJsxOutputOptions, QuoteStyle,
};

#[napi(object)]
pub struct CompileResult {
  pub output: String,
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

/// Compile a TypeScript config file to JSON or YAML.
#[napi]
pub fn compile(
  input_file: String,
  format: String,
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let opts = match options {
    Some(o) => CompileOptions {
      preserve_key_order: o.preserve_key_order.unwrap_or(false),
      jsx: o.jsx,
      env: o.env,
      jsx_output: convert_jsx_output(o.jsx_output),
      quote: parse_quote(o.quote)?,
    },
    None => CompileOptions::default(),
  };

  let (output, dependencies) = crate::compiler::compile(&input_file, &format, &opts)
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
  options: Option<JsCompileOptions>,
) -> Result<CompileResult> {
  let opts = match options {
    Some(o) => CompileOptions {
      preserve_key_order: o.preserve_key_order.unwrap_or(false),
      jsx: o.jsx,
      env: o.env,
      jsx_output: convert_jsx_output(o.jsx_output),
      quote: parse_quote(o.quote)?,
    },
    None => CompileOptions::default(),
  };

  let (output, dependencies) =
    crate::browser::compile_in_memory(&files, &entry_file, &format, &opts)
      .map_err(|e| Error::new(Status::GenericFailure, e.message.clone()))?;

  Ok(CompileResult {
    output,
    dependencies,
  })
}
