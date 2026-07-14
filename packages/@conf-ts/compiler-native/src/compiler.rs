use std::collections::HashMap;
#[cfg(not(target_family = "wasm"))]
use std::collections::HashSet;
#[cfg(not(target_family = "wasm"))]
use std::path::Path;
use std::path::PathBuf;

use swc_core::common::{FileName, SourceMap, sync::Lrc};
use swc_core::ecma::ast::{EsVersion, Module};
use swc_core::ecma::parser::{Syntax, TsSyntax, parse_file_as_module};

use crate::browser::{ProjectResolutions, compile_project};
use crate::error::ConfTSError;
#[cfg(not(target_family = "wasm"))]
use crate::eval::collect_imports;
#[cfg(not(target_family = "wasm"))]
use crate::resolver::{find_tsconfig, read_tsconfig, resolve_module};
use crate::types::CompileOptions;

#[derive(Debug, Clone, Default)]
pub struct SourceProject {
  pub files: HashMap<String, String>,
  pub resolutions: ProjectResolutions,
  pub compiler_options: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct SourceCompileInput {
  pub filename: String,
  pub code: String,
  pub project: Option<SourceProject>,
}

pub fn parse_ts_file(
  source: &str,
  file_name: &str,
  source_map: &Lrc<SourceMap>,
) -> Result<Module, ConfTSError> {
  let source_file = source_map.new_source_file(
    Lrc::new(FileName::Real(PathBuf::from(file_name))),
    source.to_string(),
  );
  let syntax = Syntax::Typescript(TsSyntax {
    tsx: file_name.ends_with(".tsx") || file_name.ends_with(".jsx"),
    decorators: true,
    ..Default::default()
  });
  let mut recoverable_errors = Vec::new();
  parse_file_as_module(
    &source_file,
    syntax,
    EsVersion::Es2022,
    None,
    &mut recoverable_errors,
  )
  .map_err(|error| {
    ConfTSError::new(
      format!("Failed to parse file {}: {:?}", file_name, error.kind()),
      file_name,
      1,
      1,
    )
  })
}

#[cfg(not(target_family = "wasm"))]
fn decode_source(bytes: &[u8], file_path: &str) -> Result<String, ConfTSError> {
  if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
    return String::from_utf8(bytes[3..].to_vec()).map_err(|error| {
      ConfTSError::new(
        format!("Failed to decode UTF-8: {}", error),
        file_path,
        1,
        1,
      )
    });
  }
  if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
    let little_endian = bytes.starts_with(&[0xff, 0xfe]);
    let body = &bytes[2..];
    if !body.len().is_multiple_of(2) {
      return Err(ConfTSError::new(
        "Failed to decode UTF-16: odd byte length",
        file_path,
        1,
        1,
      ));
    }
    let units = body.chunks_exact(2).map(|chunk| {
      if little_endian {
        u16::from_le_bytes([chunk[0], chunk[1]])
      } else {
        u16::from_be_bytes([chunk[0], chunk[1]])
      }
    });
    return String::from_utf16(&units.collect::<Vec<_>>()).map_err(|error| {
      ConfTSError::new(
        format!("Failed to decode UTF-16: {}", error),
        file_path,
        1,
        1,
      )
    });
  }
  String::from_utf8(bytes.to_vec()).map_err(|error| {
    ConfTSError::new(
      format!("Failed to decode file as UTF-8: {}", error),
      file_path,
      1,
      1,
    )
  })
}

#[cfg(not(target_family = "wasm"))]
fn read_source(path: &Path) -> Result<String, ConfTSError> {
  let display = path.display().to_string();
  let bytes = std::fs::read(path)
    .map_err(|error| ConfTSError::new(format!("Failed to read file: {}", error), &display, 1, 1))?;
  decode_source(&bytes, &display)
}

#[cfg(not(target_family = "wasm"))]
fn absolute_path(path: &str) -> Result<PathBuf, ConfTSError> {
  let input = Path::new(path);
  let absolute = if input.is_absolute() {
    input.to_path_buf()
  } else {
    std::env::current_dir()
      .map_err(|error| ConfTSError::new(format!("Failed to get CWD: {}", error), path, 1, 1))?
      .join(input)
  };
  Ok(absolute.canonicalize().unwrap_or(absolute))
}

fn load_filesystem_project(
  filename: &str,
  entry_override: Option<&str>,
) -> Result<(SourceProject, String, String), ConfTSError> {
  #[cfg(target_family = "wasm")]
  {
    let _ = (filename, entry_override);
    return Err(ConfTSError::new(
      "Path-based compile is unavailable in the WASI build; pass { filename, code, project } or use compileInMemory",
      filename,
      1,
      1,
    ));
  }

  #[cfg(not(target_family = "wasm"))]
  {
    let entry = absolute_path(filename)?;
    let entry_name = entry.display().to_string();
    let tsconfig_path = find_tsconfig(&entry)
      .ok_or_else(|| ConfTSError::new("Could not find a tsconfig.json file.", &entry_name, 1, 1))?;
    let tsconfig = read_tsconfig(&tsconfig_path)?;
    let tsconfig_dir = tsconfig_path
      .parent()
      .unwrap_or(Path::new("."))
      .to_path_buf();
    let source_map: Lrc<SourceMap> = Lrc::new(SourceMap::default());
    let mut project = SourceProject::default();
    let mut queue = vec![entry.clone()];
    let mut loaded = HashSet::new();

    while let Some(path) = queue.pop() {
      let path = path.canonicalize().unwrap_or(path);
      let path_name = path.display().to_string();
      if !loaded.insert(path_name.clone()) {
        continue;
      }
      let source = if path_name == entry_name {
        match entry_override {
          Some(source) => source.to_string(),
          None => read_source(&path)?,
        }
      } else {
        read_source(&path)?
      };
      let module = parse_ts_file(&source, &path_name, &source_map)?;
      let mut table = HashMap::new();
      for import in collect_imports(&module).values() {
        if let Some(resolved) = resolve_module(&import.source, &path, &tsconfig_dir, &tsconfig) {
          let resolved = resolved.canonicalize().unwrap_or(resolved);
          let resolved_name = resolved.display().to_string();
          table.insert(import.source.clone(), resolved_name);
          queue.push(resolved);
        }
      }
      project.resolutions.insert(path_name.clone(), table);
      project.files.insert(path_name, source);
    }

    Ok((project, entry_name, tsconfig_path.display().to_string()))
  }
}

fn compile_loaded_project(
  project: &SourceProject,
  entry_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  compile_project(
    &project.files,
    entry_file,
    Some(&project.resolutions),
    project.compiler_options.as_ref(),
    format,
    options,
  )
}

pub fn compile_path(
  input_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let (project, entry, tsconfig) = load_filesystem_project(input_file, None)?;
  let (output, mut dependencies) = compile_loaded_project(&project, &entry, format, options)?;
  dependencies.push(tsconfig);
  dependencies.sort();
  dependencies.dedup();
  Ok((output, dependencies))
}

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
    return compile_loaded_project(&project, &input.filename, format, options);
  }

  #[cfg(target_family = "wasm")]
  {
    let project = SourceProject {
      files: HashMap::from([(input.filename.clone(), input.code.clone())]),
      ..Default::default()
    };
    return compile_loaded_project(&project, &input.filename, format, options);
  }

  #[cfg(not(target_family = "wasm"))]
  {
    let (project, entry, tsconfig) = load_filesystem_project(&input.filename, Some(&input.code))?;
    let (output, mut dependencies) = compile_loaded_project(&project, &entry, format, options)?;
    dependencies.push(tsconfig);
    dependencies.sort();
    dependencies.dedup();
    Ok((output, dependencies))
  }
}

/// Legacy Rust entry point retained for embedders.
pub fn compile(
  input_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  compile_path(input_file, format, options)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn compiles_an_explicit_standalone_source_project() {
    let filename = "/virtual/config.ts";
    let input = SourceCompileInput {
      filename: filename.to_string(),
      code: "export default { answer: 40 + 2 };".to_string(),
      project: Some(SourceProject::default()),
    };
    let (output, dependencies) =
      compile_source(&input, "json", &CompileOptions::default()).unwrap();
    assert_eq!(output, "{\n  \"answer\": 42\n}");
    assert!(dependencies.contains(&filename.to_string()));
  }

  #[test]
  fn source_project_resolves_base_url_and_paths() {
    let filename = "/virtual/config.ts";
    let input = SourceCompileInput {
      filename: filename.to_string(),
      code: "import { answer } from '@/answer'; export default { answer };".to_string(),
      project: Some(SourceProject {
        files: HashMap::from([(
          "/virtual/answer.ts".to_string(),
          "export const answer = 42;".to_string(),
        )]),
        compiler_options: Some(serde_json::json!({
          "baseUrl": "/virtual",
          "paths": { "@/*": ["*"] }
        })),
        ..Default::default()
      }),
    };
    let (output, dependencies) =
      compile_source(&input, "json", &CompileOptions::default()).unwrap();
    assert_eq!(output, "{\n  \"answer\": 42\n}");
    assert!(dependencies.contains(&filename.to_string()));
    assert!(dependencies.contains(&"/virtual/answer.ts".to_string()));
  }
}
