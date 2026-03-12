use std::collections::HashMap;
use swc_common::SourceMap;
use swc_common::sync::Lrc;
use swc_ecma_ast::Module;

use crate::eval::ImportInfo;

/// The internal value type used during evaluation.
#[derive(Debug, Clone)]
pub enum Value {
  String(String),
  Number(f64),
  Bool(bool),
  Null,
  Undefined,
  Object(Vec<(String, Value)>),
  Array(Vec<Value>),
}

impl Value {
  pub fn is_truthy(&self) -> bool {
    match self {
      Value::Bool(b) => *b,
      Value::Number(n) => *n != 0.0 && !n.is_nan(),
      Value::String(s) => !s.is_empty(),
      Value::Null | Value::Undefined => false,
      Value::Object(_) | Value::Array(_) => true,
    }
  }

  pub fn to_number(&self) -> f64 {
    match self {
      Value::Number(n) => *n,
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
        if *n == f64::INFINITY {
          "Infinity".to_string()
        } else if *n == f64::NEG_INFINITY {
          "-Infinity".to_string()
        } else if n.is_nan() {
          "NaN".to_string()
        } else if *n == (*n as i64) as f64 && n.abs() < 1e15 {
          format!("{}", *n as i64)
        } else {
          format!("{}", n)
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
      (Value::Number(a), Value::Number(b)) => a == b,
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
      (Value::Number(a), Value::Number(b)) => a == b,
      (Value::String(a), Value::String(b)) => a == b,
      (Value::Bool(a), Value::Bool(b)) => a == b,
      _ => false,
    }
  }

  /// Convert to serde_json::Value for serialization.
  pub fn to_json(&self) -> serde_json::Value {
    match self {
      Value::String(s) => serde_json::Value::String(s.clone()),
      Value::Number(n) => {
        if let Some(i) = serde_json::Number::from_f64(*n) {
          serde_json::Value::Number(i)
        } else {
          serde_json::Value::Null
        }
      }
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
      Value::Number(n) => {
        if *n == (*n as i64) as f64 && n.abs() < 1e15 {
          serde_yaml::Value::Number(serde_yaml::Number::from(*n as i64))
        } else {
          serde_yaml::Value::Number(serde_yaml::Number::from(*n))
        }
      }
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

/// Compile options mirroring the TypeScript CompileOptions.
#[derive(Debug, Clone, Default)]
pub struct CompileOptions {
  pub preserve_key_order: bool,
  pub macro_mode: bool,
  pub env: Option<HashMap<String, String>>,
}

/// Per-file context containing parsed AST and metadata.
#[derive(Clone)]
pub struct FileContext {
  pub file_path: String,
  pub module: Module,
  pub source_map: Lrc<SourceMap>,
  pub imports: HashMap<String, ImportInfo>,
}
