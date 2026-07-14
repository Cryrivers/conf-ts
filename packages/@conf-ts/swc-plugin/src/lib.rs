#![allow(clippy::not_unsafe_ptr_arg_deref)]

use macro_transformer_core::{ProjectSnapshot, TransformOptions, transform_program};
use serde::Deserialize;
use swc_core::{
  common::{DUMMY_SP, plugin::metadata::TransformPluginMetadataContextKind},
  ecma::ast::Program,
  plugin::{errors::HANDLER, metadata::TransformPluginProgramMetadata, plugin_transform},
};

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PluginConfig {
  filename: Option<String>,
  project: Option<ProjectSnapshot>,
  options: Option<TransformOptions>,
  #[serde(flatten)]
  transform_options: TransformOptions,
}

fn emit_error(message: impl AsRef<str>) {
  HANDLER.with(|handler| handler.struct_span_err(DUMMY_SP, message.as_ref()).emit());
}

/// Standard SWC WASM plugin entry point. All project state is supplied in the
/// plugin config; neither this adapter nor the shared core reads the filesystem.
#[plugin_transform]
pub fn transform(program: Program, metadata: TransformPluginProgramMetadata) -> Program {
  let raw_config = metadata
    .get_transform_plugin_config()
    .unwrap_or_else(|| "{}".to_string());
  let config: PluginConfig = match serde_json::from_str(&raw_config) {
    Ok(config) => config,
    Err(error) => {
      emit_error(format!("Invalid @conf-ts/swc-plugin config: {}", error));
      return program;
    }
  };
  let filename = config
    .filename
    .or_else(|| metadata.get_context(&TransformPluginMetadataContextKind::Filename))
    .unwrap_or_else(|| "config.ts".to_string());
  let mut options = config.options.unwrap_or(config.transform_options);
  options.inherit_process_env = false;
  match transform_program(program.clone(), filename, config.project, options) {
    Ok(program) => program,
    Err(error) => {
      emit_error(error.message);
      program
    }
  }
}
