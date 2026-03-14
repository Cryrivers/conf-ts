use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::ConfTSError;

/// Parsed tsconfig.json structure (subset we need).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct TsConfig {
  #[serde(rename = "compilerOptions")]
  pub compiler_options: TsCompilerOptions,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct TsCompilerOptions {
  #[serde(rename = "baseUrl")]
  pub base_url: Option<String>,
  pub paths: Option<HashMap<String, Vec<String>>>,
}

/// Find tsconfig.json by walking up from the given file.
pub fn find_tsconfig(start_file: &Path) -> Option<PathBuf> {
  let mut dir = if start_file.is_file() {
    start_file.parent()?.to_path_buf()
  } else {
    start_file.to_path_buf()
  };
  loop {
    let candidate = dir.join("tsconfig.json");
    if candidate.exists() {
      return Some(candidate);
    }
    if !dir.pop() {
      return None;
    }
  }
}

/// Read and parse tsconfig.json.
pub fn read_tsconfig(path: &Path) -> Result<TsConfig, ConfTSError> {
  let content = std::fs::read_to_string(path).map_err(|e| {
    ConfTSError::new(
      format!("Failed to read tsconfig.json: {}", e),
      path.display().to_string(),
      1,
      1,
    )
  })?;
  // Strip single-line comments (// ...) and trailing commas for JSON5-ish compatibility
  let cleaned = strip_json_comments(&content);
  serde_json::from_str::<TsConfig>(&cleaned).map_err(|e| {
    ConfTSError::new(
      format!("Failed to parse tsconfig.json: {}", e),
      path.display().to_string(),
      1,
      1,
    )
  })
}

/// Strip single-line comments and trailing commas from JSON-like content.
fn strip_json_comments(input: &str) -> String {
  let mut result = String::with_capacity(input.len());
  let mut chars = input.chars().peekable();
  let mut in_string = false;
  let mut escape = false;

  while let Some(c) = chars.next() {
    if escape {
      result.push(c);
      escape = false;
      continue;
    }
    if in_string {
      result.push(c);
      if c == '\\' {
        escape = true;
      } else if c == '"' {
        in_string = false;
      }
      continue;
    }
    if c == '"' {
      in_string = true;
      result.push(c);
      continue;
    }
    if c == '/' {
      if chars.peek() == Some(&'/') {
        // Skip until end of line
        for nc in chars.by_ref() {
          if nc == '\n' {
            result.push('\n');
            break;
          }
        }
        continue;
      } else if chars.peek() == Some(&'*') {
        // Skip block comment
        chars.next(); // consume *
        loop {
          match chars.next() {
            Some('*') => {
              if chars.peek() == Some(&'/') {
                chars.next();
                break;
              }
            }
            Some('\n') => result.push('\n'),
            None => break,
            _ => {}
          }
        }
        continue;
      }
    }
    result.push(c);
  }

  // Remove trailing commas before } or ]
  let mut output = String::with_capacity(result.len());
  let bytes = result.as_bytes();
  let len = bytes.len();
  let mut i = 0;
  while i < len {
    if bytes[i] == b',' {
      // Look ahead past whitespace/newlines for } or ]
      let mut j = i + 1;
      while j < len
        && (bytes[j] == b' ' || bytes[j] == b'\t' || bytes[j] == b'\n' || bytes[j] == b'\r')
      {
        j += 1;
      }
      if j < len && (bytes[j] == b'}' || bytes[j] == b']') {
        // Skip the trailing comma
        i += 1;
        continue;
      }
    }
    output.push(bytes[i] as char);
    i += 1;
  }

  output
}

/// Resolve a module specifier to an absolute file path.
pub fn resolve_module(
  specifier: &str,
  from_file: &Path,
  tsconfig_dir: &Path,
  tsconfig: &TsConfig,
) -> Option<PathBuf> {
  // Try relative import first
  if specifier.starts_with('.') {
    let from_dir = from_file.parent()?;
    return resolve_file_path(&from_dir.join(specifier));
  }

  // Try path aliases
  if let Some(ref paths) = tsconfig.compiler_options.paths {
    let base_url = tsconfig.compiler_options.base_url.as_deref().unwrap_or(".");
    let base_dir = tsconfig_dir.join(base_url);

    for (pattern, targets) in paths {
      if let Some(matched) = match_path_pattern(pattern, specifier) {
        for target in targets {
          let resolved_target = target.replace('*', matched);
          let candidate = base_dir.join(&resolved_target);
          if let Some(found) = resolve_file_path(&candidate) {
            return Some(found);
          }
        }
      }
    }
  }

  None
}

/// Match a path pattern like "@/*" against a specifier like "@/constants".
fn match_path_pattern<'a>(pattern: &str, specifier: &'a str) -> Option<&'a str> {
  if let Some(prefix) = pattern.strip_suffix('*') {
    if let Some(rest) = specifier.strip_prefix(prefix) {
      return Some(rest);
    }
  } else if pattern == specifier {
    return Some("");
  }
  None
}

fn is_supported_source_path(path: &str) -> bool {
  let extensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json.ts",
    ".json.tsx",
    ".json.js",
    ".json.jsx",
  ];
  extensions.iter().any(|ext| path.ends_with(ext))
}

/// Try to resolve a path by appending common extensions.
fn resolve_file_path(base: &Path) -> Option<PathBuf> {
  let extensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json.ts",
    ".json.tsx",
    ".json.js",
    ".json.jsx",
  ];

  // Try exact path
  if base.is_file() {
    let base_str = base.to_string_lossy();
    if is_supported_source_path(&base_str) {
      return Some(base.canonicalize().unwrap_or_else(|_| base.to_path_buf()));
    }
    return None;
  }

  // Try with extensions
  for ext in &extensions {
    let with_ext = base.with_extension(&ext[1..]); // Remove the leading dot
    if with_ext.is_file() {
      return Some(with_ext.canonicalize().unwrap_or_else(|_| with_ext));
    }
  }

  // Try index files
  for ext in &extensions {
    let index = base.join(format!("index{}", ext));
    if index.is_file() {
      return Some(index.canonicalize().unwrap_or_else(|_| index));
    }
  }

  None
}

/// In-memory module resolution for browser mode.
pub fn resolve_module_in_memory(
  specifier: &str,
  from_file: &str,
  files: &HashMap<String, String>,
) -> Option<String> {
  if !specifier.starts_with('.') {
    return None;
  }

  let from_dir = Path::new(from_file).parent().unwrap_or(Path::new("/"));
  let base = from_dir.join(specifier);
  let base_str = base.to_string_lossy();

  // Try exact
  if files.contains_key(base_str.as_ref()) && is_supported_source_path(&base_str) {
    return Some(base_str.to_string());
  }

  let extensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json.ts",
    ".json.tsx",
    ".json.js",
    ".json.jsx",
  ];
  for ext in &extensions {
    let with_ext = format!("{}{}", base_str, ext);
    if files.contains_key(&with_ext) {
      return Some(with_ext);
    }
  }

  for ext in &extensions {
    let index = format!("{}/index{}", base_str, ext);
    if files.contains_key(&index) {
      return Some(index);
    }
  }

  None
}
