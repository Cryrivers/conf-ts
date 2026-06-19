use std::collections::HashMap;
use std::rc::Rc;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;

use crate::error::ConfTSError;
use crate::eval::ImportInfo;

const RAW_NUMBER_PREFIX: &str = "__CONF_TS_NUMBER__";
const RAW_NUMBER_SUFFIX: &str = "__CONF_TS_NUMBER_END__";

pub struct FileOwner {
  pub allocator: Allocator,
  pub source: String,
}

pub struct ParsedProgram<'a> {
  pub program: Program<'a>,
}

self_cell::self_cell! {
  pub struct ParsedFile {
    owner: FileOwner,
    #[covariant]
    dependent: ParsedProgram,
  }
}

impl ParsedFile {
  pub fn program(&self) -> &Program<'_> {
    &self.borrow_dependent().program
  }

  pub fn source(&self) -> &str {
    &self.borrow_owner().source
  }
}

#[derive(Clone)]
pub struct LineIndex {
  line_starts: Vec<u32>,
}

impl LineIndex {
  pub fn new(source: &str) -> Self {
    let mut line_starts = vec![0u32];
    for (i, byte) in source.bytes().enumerate() {
      if byte == b'\n' {
        line_starts.push((i + 1) as u32);
      }
    }
    LineIndex { line_starts }
  }

  pub fn get_location(&self, offset: u32) -> (usize, usize) {
    let line = match self.line_starts.binary_search(&offset) {
      Ok(idx) => idx,
      Err(idx) => idx.saturating_sub(1),
    };
    let col = offset.saturating_sub(self.line_starts[line]);
    (line + 1, col as usize + 1)
  }
}

#[derive(Debug, Clone)]
pub struct NumberValue {
  pub value: f64,
  pub raw: Option<String>,
}

/// The internal value type used during evaluation.
#[derive(Debug, Clone)]
pub enum Value {
  String(String),
  Number(NumberValue),
  Bool(bool),
  Null,
  Undefined,
  Object(Vec<(String, Value)>),
  Array(Vec<Value>),
}

impl Value {
  pub fn typeof_string(&self) -> &'static str {
    match self {
      Value::String(_) => "string",
      Value::Number(_) => "number",
      Value::Bool(_) => "boolean",
      Value::Undefined => "undefined",
      Value::Null | Value::Object(_) | Value::Array(_) => "object",
    }
  }

  pub fn is_truthy(&self) -> bool {
    match self {
      Value::Bool(b) => *b,
      Value::Number(n) => n.value != 0.0 && !n.value.is_nan(),
      Value::String(s) => !s.is_empty(),
      Value::Null | Value::Undefined => false,
      Value::Object(_) | Value::Array(_) => true,
    }
  }

  pub fn to_number(&self) -> f64 {
    match self {
      Value::Number(n) => n.value,
      Value::Bool(true) => 1.0,
      Value::Bool(false) => 0.0,
      Value::String(s) => s.parse::<f64>().unwrap_or(f64::NAN),
      Value::Null => 0.0,
      Value::Undefined => f64::NAN,
      _ => f64::NAN,
    }
  }

  pub fn to_display_string(&self) -> String {
    match self {
      Value::String(s) => s.clone(),
      Value::Number(n) => {
        if n.value == f64::INFINITY {
          "Infinity".to_string()
        } else if n.value == f64::NEG_INFINITY {
          "-Infinity".to_string()
        } else if n.value.is_nan() {
          "NaN".to_string()
        } else if n.value == (n.value as i64) as f64 && n.value.abs() < 1e15 {
          format!("{}", n.value as i64)
        } else {
          format!("{}", n.value)
        }
      }
      Value::Bool(b) => b.to_string(),
      Value::Null => "null".to_string(),
      Value::Undefined => "undefined".to_string(),
      Value::Object(_) => "[object Object]".to_string(),
      Value::Array(arr) => {
        let items: Vec<String> = arr.iter().map(|v| v.to_display_string()).collect();
        items.join(",")
      }
    }
  }

  pub fn loose_eq(&self, other: &Value) -> bool {
    match (self, other) {
      (Value::Null, Value::Null)
      | (Value::Null, Value::Undefined)
      | (Value::Undefined, Value::Null)
      | (Value::Undefined, Value::Undefined) => true,
      (Value::Number(a), Value::Number(b)) => a.value == b.value,
      (Value::String(a), Value::String(b)) => a == b,
      (Value::Bool(a), Value::Bool(b)) => a == b,
      (Value::Number(_), Value::String(s)) => {
        let n = s.parse::<f64>().unwrap_or(f64::NAN);
        self.to_number() == n
      }
      (Value::String(s), Value::Number(_)) => {
        let n = s.parse::<f64>().unwrap_or(f64::NAN);
        n == other.to_number()
      }
      _ => false,
    }
  }

  pub fn strict_eq(&self, other: &Value) -> bool {
    match (self, other) {
      (Value::Null, Value::Null) => true,
      (Value::Undefined, Value::Undefined) => true,
      (Value::Number(a), Value::Number(b)) => a.value == b.value,
      (Value::String(a), Value::String(b)) => a == b,
      (Value::Bool(a), Value::Bool(b)) => a == b,
      _ => false,
    }
  }

  /// Convert to serde_json::Value for serialization.
  pub fn to_json(&self) -> serde_json::Value {
    match self {
      Value::String(s) => serde_json::Value::String(s.clone()),
      Value::Number(n) => match &n.raw {
        Some(raw) => serde_json::Value::String(encode_raw_number(raw)),
        None => {
          if n.value.is_finite() && n.value == (n.value as i64) as f64 && n.value.abs() < 1e15 {
            serde_json::Value::Number(serde_json::Number::from(n.value as i64))
          } else if let Some(i) = serde_json::Number::from_f64(n.value) {
            serde_json::Value::Number(i)
          } else {
            serde_json::Value::Null
          }
        }
      },
      Value::Bool(b) => serde_json::Value::Bool(*b),
      Value::Null | Value::Undefined => serde_json::Value::Null,
      Value::Object(map) => {
        let mut obj = serde_json::Map::new();
        for (k, v) in map {
          if let Value::Undefined = v {
            continue;
          }
          obj.insert(k.clone(), v.to_json());
        }
        serde_json::Value::Object(obj)
      }
      Value::Array(arr) => {
        let items: Vec<serde_json::Value> = arr.iter().map(|v| v.to_json()).collect();
        serde_json::Value::Array(items)
      }
    }
  }

  /// Convert to serde_yaml::Value for YAML serialization.
  pub fn to_yaml(&self) -> serde_yaml::Value {
    match self {
      Value::String(s) => serde_yaml::Value::String(s.clone()),
      Value::Number(n) => match &n.raw {
        Some(raw) => serde_yaml::Value::String(encode_raw_number(raw)),
        None => {
          if n.value == (n.value as i64) as f64 && n.value.abs() < 1e15 {
            serde_yaml::Value::Number(serde_yaml::Number::from(n.value as i64))
          } else {
            serde_yaml::Value::Number(serde_yaml::Number::from(n.value))
          }
        }
      },
      Value::Bool(b) => serde_yaml::Value::Bool(*b),
      Value::Null | Value::Undefined => serde_yaml::Value::Null,
      Value::Object(map) => {
        let mut mapping = serde_yaml::Mapping::new();
        for (k, v) in map {
          if let Value::Undefined = v {
            continue;
          }
          mapping.insert(serde_yaml::Value::String(k.clone()), v.to_yaml());
        }
        serde_yaml::Value::Mapping(mapping)
      }
      Value::Array(arr) => {
        let items: Vec<serde_yaml::Value> = arr.iter().map(|v| v.to_yaml()).collect();
        serde_yaml::Value::Sequence(items)
      }
    }
  }
}

fn encode_raw_number(raw: &str) -> String {
  format!("{}{}{}", RAW_NUMBER_PREFIX, raw, RAW_NUMBER_SUFFIX)
}

pub fn normalize_number_raw(raw: Option<String>) -> Option<String> {
  let raw = raw?;
  let normalized = raw.replace('_', "");
  if normalized.ends_with('.') {
    return None;
  }
  if normalized.contains('.') || normalized.contains('e') || normalized.contains('E') {
    Some(normalized)
  } else {
    None
  }
}

pub fn replace_raw_number_markers(input: &str) -> String {
  let mut output = String::with_capacity(input.len());
  let mut index = 0;
  while let Some(rel_start) = input[index..].find(RAW_NUMBER_PREFIX) {
    let start = index + rel_start;
    let raw_start = start + RAW_NUMBER_PREFIX.len();
    let Some(rel_end) = input[raw_start..].find(RAW_NUMBER_SUFFIX) else {
      break;
    };
    let raw_end = raw_start + rel_end;
    let suffix_end = raw_end + RAW_NUMBER_SUFFIX.len();
    let mut remove_quotes = false;
    if start > 0 {
      let prev = input.as_bytes()[start - 1];
      if prev == b'"' || prev == b'\'' {
        if input.as_bytes().get(suffix_end) == Some(&prev) {
          remove_quotes = true;
        }
      }
    }
    let segment_end = if remove_quotes { start - 1 } else { start };
    output.push_str(&input[index..segment_end]);
    output.push_str(&input[raw_start..raw_end]);
    index = if remove_quotes {
      suffix_end + 1
    } else {
      suffix_end
    };
  }
  output.push_str(&input[index..]);
  output
}

pub fn serialize_output(output: &Value, format: &str) -> Result<String, ConfTSError> {
  match format {
    "json" => {
      let json_value = output.to_json();
      let json_str = serde_json::to_string_pretty(&json_value).map_err(|e| {
        ConfTSError::new(format!("Failed to serialize JSON: {}", e), "unknown", 1, 1)
      })?;
      Ok(replace_raw_number_markers(&json_str))
    }
    "yaml" => {
      let yaml_value = output.to_yaml();
      let yaml_str = serde_yaml::to_string(&yaml_value).map_err(|e| {
        ConfTSError::new(format!("Failed to serialize YAML: {}", e), "unknown", 1, 1)
      })?;

      let processed = yaml_str
        .strip_prefix("---\n")
        .unwrap_or(&yaml_str)
        .to_string();

      let mut processed_lines = String::new();
      for line in processed.lines() {
        let mut new_line = line.to_string();
        let indent_len = new_line.len() - new_line.trim_start().len();
        if new_line[indent_len..].starts_with('\'') {
          if let Some(rel_key_end) = new_line[indent_len + 1..].find("':") {
            let key_end = indent_len + 1 + rel_key_end;
            new_line.replace_range(key_end..key_end + 1, "\"");
            new_line.replace_range(indent_len..indent_len + 1, "\"");
          }
        }
        if (new_line.contains(": '") || new_line.contains("- '")) && new_line.ends_with('\'') {
          new_line = new_line.replace('\'', "\"");
        }
        processed_lines.push_str(&new_line);
        processed_lines.push_str("\n");
      }

      Ok(replace_raw_number_markers(&processed_lines))
    }
    _ => Err(ConfTSError::new(
      format!("Unsupported format: {}", format),
      "unknown",
      1,
      1,
    )),
  }
}

impl Value {
  pub fn number(value: f64) -> Self {
    Value::Number(NumberValue { value, raw: None })
  }

  pub fn number_with_raw(value: f64, raw: Option<String>) -> Self {
    Value::Number(NumberValue { value, raw })
  }
}

/// Compile options mirroring the TypeScript CompileOptions.
#[derive(Debug, Clone, Default)]
pub struct CompileOptions {
  pub preserve_key_order: bool,
  pub macro_mode: bool,
  pub env: Option<HashMap<String, String>>,
  pub jsx_output: Option<JsxOutputOptions>,
}

#[derive(Debug, Clone)]
pub enum JsxOutputField {
  Name(String),
  Disabled,
  InvalidBool,
}

#[derive(Debug, Clone, Default)]
pub struct JsxOutputOptions {
  pub type_name: Option<String>,
  pub props: Option<JsxOutputField>,
  pub children: Option<JsxOutputField>,
  pub key: Option<String>,
  pub fragment: Option<String>,
  pub type_format: Option<String>,
}

/// Per-file context containing parsed AST and metadata.
#[derive(Clone)]
pub struct FileContext {
  pub file_path: String,
  pub parsed: Rc<ParsedFile>,
  pub line_index: LineIndex,
  pub imports: HashMap<String, ImportInfo>,
}

impl FileContext {
  pub fn program(&self) -> &Program<'_> {
    self.parsed.program()
  }
}
