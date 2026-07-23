#![allow(clippy::too_many_arguments)]

use std::collections::{BTreeMap, HashMap, HashSet};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

#[napi(object)]
pub struct JsDiffProject {
  pub filename: String,
  pub code: String,
  pub files: Option<HashMap<String, String>>,
  #[napi(ts_type = "any")]
  pub evaluated: Option<Value>,
  pub dependencies: Option<Vec<String>>,
  pub evaluation_error: Option<String>,
}

#[derive(Default)]
#[napi(object)]
pub struct JsDiffOptions {
  pub array_keys: Option<HashMap<String, String>>,
  pub redact: Option<Vec<String>>,
  pub redact_all: Option<bool>,
  pub include_source: Option<bool>,
  pub max_match_work: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceLocation {
  file: String,
  start: u32,
  end: u32,
  line: usize,
  column: usize,
  end_line: usize,
  end_column: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StructureNode {
  id: String,
  path: String,
  label: String,
  kind: String,
  semantic_hash: String,
  source_hash: String,
  span: SourceLocation,
  #[serde(skip_serializing_if = "Option::is_none")]
  value_preview: Option<Value>,
  children: Vec<StructureNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValuePreview {
  value_type: String,
  preview: Value,
  redacted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeSpans {
  #[serde(skip_serializing_if = "Option::is_none")]
  before: Option<SourceLocation>,
  #[serde(skip_serializing_if = "Option::is_none")]
  after: Option<SourceLocation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffChange {
  id: String,
  classification: String,
  kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  path_before: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  path_after: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  before: Option<ValuePreview>,
  #[serde(skip_serializing_if = "Option::is_none")]
  after: Option<ValuePreview>,
  spans: ChangeSpans,
  origin_chain: Vec<SourceLocation>,
  related_change_ids: Vec<String>,
  ignored: bool,
  sensitive: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  match_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
  side: String,
  severity: String,
  code: String,
  message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  location: Option<SourceLocation>,
}

#[derive(Debug)]
struct ParsedSide {
  root: Option<StructureNode>,
  diagnostics: Vec<Diagnostic>,
}

struct ExtractContext<'a> {
  filename: &'a str,
  source: &'a str,
  comments: Vec<(Span, String)>,
}

struct DiffContext<'a> {
  array_keys: &'a HashMap<String, String>,
  redact: &'a [String],
  redact_all: bool,
  max_match_work: usize,
  work: usize,
  diagnostics: Vec<Diagnostic>,
  before_nodes: HashMap<String, &'a StructureNode>,
  after_nodes: HashMap<String, &'a StructureNode>,
}

fn fnv_hash(text: &str) -> String {
  let mut hash = 0xcbf29ce484222325_u64;
  for byte in text.as_bytes() {
    hash ^= u64::from(*byte);
    hash = hash.wrapping_mul(0x100000001b3);
  }
  format!("{hash:016x}")
}

fn pointer_escape(value: &str) -> String {
  value.replace('~', "~0").replace('/', "~1")
}

fn child_path(parent: &str, segment: &str) -> String {
  if parent.is_empty() {
    format!("/{}", pointer_escape(segment))
  } else {
    format!("{}/{}", parent, pointer_escape(segment))
  }
}

fn line_column(source: &str, offset: u32) -> (usize, usize) {
  let offset = (offset as usize).min(source.len());
  let prefix = &source[..offset];
  let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
  let column = prefix
    .rfind('\n')
    .map_or(offset + 1, |position| offset - position);
  (line, column)
}

fn location(filename: &str, source: &str, span: Span) -> SourceLocation {
  let (line, column) = line_column(source, span.start);
  let (end_line, end_column) = line_column(source, span.end);
  SourceLocation {
    file: filename.to_string(),
    start: span.start,
    end: span.end,
    line,
    column,
    end_line,
    end_column,
  }
}

fn source_slice(source: &str, span: Span) -> &str {
  source
    .get(span.start as usize..span.end as usize)
    .unwrap_or_default()
}

fn normalize_expression(text: &str) -> String {
  let mut output = String::with_capacity(text.len());
  let mut chars = text.chars().peekable();
  let mut quote: Option<char> = None;
  let mut escaped = false;
  let mut line_comment = false;
  let mut block_comment = false;
  while let Some(character) = chars.next() {
    if line_comment {
      if character == '\n' {
        line_comment = false;
      }
      continue;
    }
    if block_comment {
      if character == '*' && chars.peek() == Some(&'/') {
        chars.next();
        block_comment = false;
      }
      continue;
    }
    if let Some(active_quote) = quote {
      output.push(character);
      if escaped {
        escaped = false;
      } else if character == '\\' {
        escaped = true;
      } else if character == active_quote {
        quote = None;
      }
      continue;
    }
    if matches!(character, '\'' | '"' | '`') {
      quote = Some(character);
      output.push(character);
      continue;
    }
    if character == '/' && chars.peek() == Some(&'/') {
      chars.next();
      line_comment = true;
      continue;
    }
    if character == '/' && chars.peek() == Some(&'*') {
      chars.next();
      block_comment = true;
      continue;
    }
    if !character.is_whitespace() {
      output.push(character);
    }
  }
  output
}

fn comments_for_span(context: &ExtractContext<'_>, span: Span) -> String {
  context
    .comments
    .iter()
    .filter(|(comment_span, _)| comment_span.start >= span.start && comment_span.end <= span.end)
    .map(|(_, text)| text.trim())
    .collect::<Vec<_>>()
    .join("|")
}

fn scalar_preview(expression: &Expression<'_>) -> Option<Value> {
  match expression {
    Expression::StringLiteral(value) => Some(Value::String(value.value.to_string())),
    Expression::NumericLiteral(value) => {
      serde_json::Number::from_f64(value.value).map(Value::Number)
    }
    Expression::BooleanLiteral(value) => Some(Value::Bool(value.value)),
    Expression::NullLiteral(_) => Some(Value::Null),
    _ => None,
  }
}

fn property_name(property: &ObjectProperty<'_>, context: &ExtractContext<'_>) -> Option<String> {
  if property.computed {
    return None;
  }
  match &property.key {
    PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
    PropertyKey::StringLiteral(value) => Some(value.value.to_string()),
    PropertyKey::NumericLiteral(value) => Some(value.value.to_string()),
    _ => {
      let raw = source_slice(context.source, property.key.span());
      (!raw.is_empty()).then(|| raw.to_string())
    }
  }
}

fn make_node(
  context: &ExtractContext<'_>,
  path: String,
  label: String,
  kind: &str,
  span: Span,
  semantic_signature: String,
  source_signature: String,
  value_preview: Option<Value>,
  children: Vec<StructureNode>,
) -> StructureNode {
  StructureNode {
    id: format!(
      "node-{}",
      fnv_hash(&format!("{path}:{kind}:{semantic_signature}"))
    ),
    path,
    label,
    kind: kind.to_string(),
    semantic_hash: fnv_hash(&semantic_signature),
    source_hash: fnv_hash(&source_signature),
    span: location(context.filename, context.source, span),
    value_preview,
    children,
  }
}

fn expression_node(
  expression: &Expression<'_>,
  path: String,
  label: String,
  context: &ExtractContext<'_>,
) -> StructureNode {
  match expression {
    Expression::ParenthesizedExpression(value) => {
      expression_node(&value.expression, path, label, context)
    }
    Expression::TSAsExpression(value) => {
      let child = expression_node(&value.expression, path.clone(), label.clone(), context);
      let type_text = source_slice(context.source, value.type_annotation.span());
      let source_signature = format!(
        "as:{}:{}",
        child.source_hash,
        normalize_expression(type_text)
      );
      make_node(
        context,
        path,
        label,
        &child.kind,
        value.span,
        child.semantic_hash.clone(),
        source_signature,
        child.value_preview,
        child.children,
      )
    }
    Expression::TSSatisfiesExpression(value) => {
      let child = expression_node(&value.expression, path.clone(), label.clone(), context);
      let type_text = source_slice(context.source, value.type_annotation.span());
      let source_signature = format!(
        "satisfies:{}:{}",
        child.source_hash,
        normalize_expression(type_text)
      );
      make_node(
        context,
        path,
        label,
        &child.kind,
        value.span,
        child.semantic_hash.clone(),
        source_signature,
        child.value_preview,
        child.children,
      )
    }
    Expression::TSNonNullExpression(value) => {
      let child = expression_node(&value.expression, path.clone(), label.clone(), context);
      make_node(
        context,
        path,
        label,
        &child.kind,
        value.span,
        child.semantic_hash.clone(),
        format!("nonnull:{}", child.source_hash),
        child.value_preview,
        child.children,
      )
    }
    Expression::ObjectExpression(object) => {
      let mut children = Vec::new();
      let mut spread_index = 0;
      for property in &object.properties {
        match property {
          ObjectPropertyKind::ObjectProperty(property) => {
            let key = property_name(property, context)
              .unwrap_or_else(|| format!("[computed:{}]", spread_index));
            let property_path = child_path(&path, &key);
            let child = expression_node(&property.value, property_path, key, context);
            children.push(child);
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            let key = format!("...{}", spread_index);
            let property_path = child_path(&path, &key);
            children.push(expression_node(
              &spread.argument,
              property_path,
              key,
              context,
            ));
            spread_index += 1;
          }
        }
      }
      let mut semantic_children = children
        .iter()
        .map(|child| format!("{}:{}", child.label, child.semantic_hash))
        .collect::<Vec<_>>();
      semantic_children.sort();
      let semantic_signature = format!("object{{{}}}", semantic_children.join(","));
      let source_signature = format!(
        "object{{{}}}:{}",
        children
          .iter()
          .map(|child| format!("{}:{}", child.label, child.source_hash))
          .collect::<Vec<_>>()
          .join(","),
        comments_for_span(context, object.span)
      );
      make_node(
        context,
        path,
        label,
        "object",
        object.span,
        semantic_signature,
        source_signature,
        None,
        children,
      )
    }
    Expression::ArrayExpression(array) => {
      let mut children = Vec::new();
      for (index, element) in array.elements.iter().enumerate() {
        let item_path = child_path(&path, &index.to_string());
        let item_label = index.to_string();
        if let Some(expression) = element.as_expression() {
          children.push(expression_node(expression, item_path, item_label, context));
        } else if let ArrayExpressionElement::SpreadElement(spread) = element {
          children.push(expression_node(
            &spread.argument,
            item_path,
            format!("...{index}"),
            context,
          ));
        } else {
          let span = element.span();
          children.push(make_node(
            context,
            item_path,
            item_label,
            "elision",
            span,
            "undefined".to_string(),
            "elision".to_string(),
            None,
            Vec::new(),
          ));
        }
      }
      let semantic_signature = format!(
        "array[{}]",
        children
          .iter()
          .map(|child| child.semantic_hash.as_str())
          .collect::<Vec<_>>()
          .join(",")
      );
      let source_signature = format!(
        "array[{}]:{}",
        children
          .iter()
          .map(|child| child.source_hash.as_str())
          .collect::<Vec<_>>()
          .join(","),
        comments_for_span(context, array.span)
      );
      make_node(
        context,
        path,
        label,
        "array",
        array.span,
        semantic_signature,
        source_signature,
        None,
        children,
      )
    }
    _ => {
      let span = expression.span();
      let raw = source_slice(context.source, span);
      let preview = scalar_preview(expression);
      let semantic_signature = match &preview {
        Some(value) => format!("literal:{}", canonical_json(value)),
        None => format!("expr:{}", normalize_expression(raw)),
      };
      let source_signature = match expression {
        Expression::StringLiteral(value) => format!("string:{}", value.value),
        Expression::NumericLiteral(_) => format!("number:{}", normalize_expression(raw)),
        _ => format!(
          "{}:{}",
          normalize_expression(raw),
          comments_for_span(context, span)
        ),
      };
      make_node(
        context,
        path,
        label,
        value_type(preview.as_ref().unwrap_or(&Value::Null)),
        span,
        semantic_signature,
        source_signature,
        preview,
        Vec::new(),
      )
    }
  }
}

fn parse_side(side: &str, filename: &str, source: &str) -> ParsedSide {
  let allocator = Allocator::default();
  let source_type = SourceType::from_path(filename).unwrap_or_default();
  let parsed = Parser::new(&allocator, source, source_type).parse();
  let mut diagnostics = parsed
    .diagnostics
    .iter()
    .map(|diagnostic| Diagnostic {
      side: side.to_string(),
      severity: "error".to_string(),
      code: "parse-error".to_string(),
      message: diagnostic.to_string(),
      location: None,
    })
    .collect::<Vec<_>>();
  if parsed.panicked {
    return ParsedSide {
      root: None,
      diagnostics,
    };
  }
  let comments = parsed
    .program
    .comments
    .iter()
    .map(|comment| (comment.span, source_slice(source, comment.span).to_string()))
    .collect();
  let context = ExtractContext {
    filename,
    source,
    comments,
  };
  for statement in &parsed.program.body {
    if let Statement::ExportDefaultDeclaration(export) = statement
      && let Some(expression) = export.declaration.as_expression()
    {
      return ParsedSide {
        root: Some(expression_node(
          expression,
          String::new(),
          "default".to_string(),
          &context,
        )),
        diagnostics,
      };
    }
  }
  diagnostics.push(Diagnostic {
    side: side.to_string(),
    severity: "error".to_string(),
    code: "missing-default-export".to_string(),
    message: format!("No default export expression found in {filename}"),
    location: None,
  });
  ParsedSide {
    root: None,
    diagnostics,
  }
}

fn canonical_json(value: &Value) -> String {
  match value {
    Value::Object(object) => {
      let mut entries = object
        .iter()
        .map(|(key, value)| {
          format!(
            "{}:{}",
            serde_json::to_string(key).unwrap(),
            canonical_json(value)
          )
        })
        .collect::<Vec<_>>();
      entries.sort();
      format!("{{{}}}", entries.join(","))
    }
    Value::Array(array) => format!(
      "[{}]",
      array
        .iter()
        .map(canonical_json)
        .collect::<Vec<_>>()
        .join(",")
    ),
    _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
  }
}

fn value_type(value: &Value) -> &'static str {
  match value {
    Value::Null => "null",
    Value::Bool(_) => "boolean",
    Value::Number(_) => "number",
    Value::String(_) => "string",
    Value::Array(_) => "array",
    Value::Object(_) => "object",
  }
}

fn pointer_matches(pattern: &str, path: &str) -> bool {
  let pattern_parts = pattern.split('/').skip(1).collect::<Vec<_>>();
  let path_parts = path.split('/').skip(1).collect::<Vec<_>>();
  fn inner(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.first() {
      None => path.is_empty(),
      Some(&"**") => inner(&pattern[1..], path) || (!path.is_empty() && inner(pattern, &path[1..])),
      Some(&"*") => !path.is_empty() && inner(&pattern[1..], &path[1..]),
      Some(segment) => !path.is_empty() && *segment == path[0] && inner(&pattern[1..], &path[1..]),
    }
  }
  inner(&pattern_parts, &path_parts)
}

fn is_redacted(context: &DiffContext<'_>, path: &str) -> bool {
  context.redact_all
    || context
      .redact
      .iter()
      .any(|pattern| pointer_matches(pattern, path))
}

fn preview(value: &Value, redacted: bool) -> ValuePreview {
  let preview = if redacted {
    Value::String("••••••".to_string())
  } else {
    match value {
      Value::String(text) if text.len() > 160 => {
        Value::String(format!("{}…", &text[..text.floor_char_boundary(160)]))
      }
      Value::Array(array) if array.len() > 12 => {
        json!({ "length": array.len(), "preview": &array[..12] })
      }
      Value::Object(object) if object.len() > 12 => {
        let entries = object
          .iter()
          .take(12)
          .map(|(key, value)| (key.clone(), value.clone()))
          .collect::<Map<_, _>>();
        json!({ "keys": object.len(), "preview": entries })
      }
      _ => value.clone(),
    }
  };
  ValuePreview {
    value_type: value_type(value).to_string(),
    preview,
    redacted,
  }
}

fn flatten_nodes<'a>(node: &'a StructureNode, output: &mut HashMap<String, &'a StructureNode>) {
  output.insert(node.path.clone(), node);
  for child in &node.children {
    flatten_nodes(child, output);
  }
}

fn span_for(nodes: &HashMap<String, &StructureNode>, path: &str) -> Option<SourceLocation> {
  let mut current = path.to_string();
  loop {
    if let Some(node) = nodes.get(&current) {
      return Some(node.span.clone());
    }
    if current.is_empty() {
      return None;
    }
    current = current
      .rsplit_once('/')
      .map_or_else(String::new, |(parent, _)| parent.to_string());
  }
}

fn make_change(
  context: &DiffContext<'_>,
  classification: &str,
  kind: &str,
  path_before: Option<String>,
  path_after: Option<String>,
  before: Option<&Value>,
  after: Option<&Value>,
  match_reason: Option<String>,
) -> DiffChange {
  let path = path_after
    .as_deref()
    .or(path_before.as_deref())
    .unwrap_or_default();
  let sensitive = is_redacted(context, path);
  let key = format!(
    "{classification}:{kind}:{}:{}",
    path_before.as_deref().unwrap_or_default(),
    path_after.as_deref().unwrap_or_default()
  );
  let before_span = path_before
    .as_deref()
    .and_then(|path| span_for(&context.before_nodes, path));
  let after_span = path_after
    .as_deref()
    .and_then(|path| span_for(&context.after_nodes, path));
  let origin_chain = [before_span.clone(), after_span.clone()]
    .into_iter()
    .flatten()
    .collect();
  DiffChange {
    id: format!("change-{}", fnv_hash(&key)),
    classification: classification.to_string(),
    kind: kind.to_string(),
    spans: ChangeSpans {
      before: before_span,
      after: after_span,
    },
    origin_chain,
    path_before,
    path_after,
    before: before.map(|value| preview(value, sensitive)),
    after: after.map(|value| preview(value, sensitive)),
    related_change_ids: Vec::new(),
    ignored: false,
    sensitive,
    match_reason,
  }
}

fn primitive_identity(value: &Value) -> Option<String> {
  match value {
    Value::String(text) => Some(format!("s:{text}")),
    Value::Number(number) => Some(format!("n:{number}")),
    Value::Bool(value) => Some(format!("b:{value}")),
    _ => None,
  }
}

fn identity_field(
  path: &str,
  before: &[Value],
  after: &[Value],
  configured: Option<&String>,
) -> Option<String> {
  let candidates = configured.cloned().map_or_else(
    || vec!["id".to_string(), "name".to_string(), "key".to_string()],
    |key| vec![key],
  );
  for candidate in candidates {
    let mut before_values = HashSet::new();
    let mut after_values = HashSet::new();
    let mut valid = true;
    for (items, seen) in [(before, &mut before_values), (after, &mut after_values)] {
      for item in items {
        let Some(identity) = item
          .as_object()
          .and_then(|object| object.get(&candidate))
          .and_then(primitive_identity)
        else {
          valid = false;
          break;
        };
        if !seen.insert(identity) {
          valid = false;
          break;
        }
      }
      if !valid {
        break;
      }
    }
    if valid
      && (!before_values.is_empty() || !after_values.is_empty())
      && (before_values.is_empty()
        || after_values.is_empty()
        || before_values
          .iter()
          .any(|value| after_values.contains(value)))
    {
      return Some(candidate);
    }
  }
  let _ = path;
  None
}

fn keyed_array_map<'a>(items: &'a [Value], field: &str) -> BTreeMap<String, (usize, &'a Value)> {
  items
    .iter()
    .enumerate()
    .filter_map(|(index, item)| {
      item
        .as_object()
        .and_then(|object| object.get(field))
        .and_then(primitive_identity)
        .map(|identity| (identity, (index, item)))
    })
    .collect()
}

fn diff_values(
  before: &Value,
  after: &Value,
  path: &str,
  context: &mut DiffContext<'_>,
  changes: &mut Vec<DiffChange>,
) {
  if before == after {
    return;
  }
  context.work += 1;
  if context.work > context.max_match_work {
    changes.push(make_change(
      context,
      "semantic",
      "modify",
      Some(path.to_string()),
      Some(path.to_string()),
      Some(before),
      Some(after),
      Some("matching-budget-exhausted".to_string()),
    ));
    if !context
      .diagnostics
      .iter()
      .any(|diagnostic| diagnostic.code == "matching-degraded")
    {
      context.diagnostics.push(Diagnostic {
        side: "both".to_string(),
        severity: "warning".to_string(),
        code: "matching-degraded".to_string(),
        message: "Structural matching exceeded maxMatchWork; the remaining subtree was compared as a replacement.".to_string(),
        location: None,
      });
    }
    return;
  }
  match (before, after) {
    (Value::Object(before_object), Value::Object(after_object)) => {
      let mut removed = before_object
        .keys()
        .filter(|key| !after_object.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
      let mut added = after_object
        .keys()
        .filter(|key| !before_object.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
      let mut renamed = Vec::new();
      for old_key in &removed {
        let matches = added
          .iter()
          .filter(|new_key| before_object.get(old_key) == after_object.get(*new_key))
          .cloned()
          .collect::<Vec<_>>();
        if matches.len() == 1 {
          renamed.push((old_key.clone(), matches[0].clone()));
        }
      }
      for (old_key, new_key) in &renamed {
        removed.retain(|key| key != old_key);
        added.retain(|key| key != new_key);
        let old_path = child_path(path, old_key);
        let new_path = child_path(path, new_key);
        changes.push(make_change(
          context,
          "semantic",
          "rename",
          Some(old_path),
          Some(new_path),
          before_object.get(old_key),
          after_object.get(new_key),
          Some("unique-identical-subtree".to_string()),
        ));
      }
      for key in removed {
        let item_path = child_path(path, &key);
        changes.push(make_change(
          context,
          "semantic",
          "remove",
          Some(item_path),
          None,
          before_object.get(&key),
          None,
          None,
        ));
      }
      for key in added {
        let item_path = child_path(path, &key);
        changes.push(make_change(
          context,
          "semantic",
          "add",
          None,
          Some(item_path),
          None,
          after_object.get(&key),
          None,
        ));
      }
      for key in before_object
        .keys()
        .filter(|key| after_object.contains_key(*key))
      {
        diff_values(
          &before_object[key],
          &after_object[key],
          &child_path(path, key),
          context,
          changes,
        );
      }
    }
    (Value::Array(before_array), Value::Array(after_array)) => {
      let configured = context.array_keys.get(path);
      if let Some(field) = identity_field(path, before_array, after_array, configured) {
        let before_map = keyed_array_map(before_array, &field);
        let after_map = keyed_array_map(after_array, &field);
        for (identity, (before_index, before_value)) in &before_map {
          if let Some((after_index, after_value)) = after_map.get(identity) {
            let before_path = child_path(path, &before_index.to_string());
            let after_path = child_path(path, &after_index.to_string());
            if before_index != after_index {
              changes.push(make_change(
                context,
                "semantic",
                "move",
                Some(before_path.clone()),
                Some(after_path.clone()),
                Some(before_value),
                Some(after_value),
                Some(format!("array-key:{field}")),
              ));
            }
            diff_values(before_value, after_value, &after_path, context, changes);
          } else {
            let item_path = child_path(path, &before_index.to_string());
            changes.push(make_change(
              context,
              "semantic",
              "remove",
              Some(item_path),
              None,
              Some(before_value),
              None,
              Some(format!("array-key:{field}")),
            ));
          }
        }
        for (identity, (after_index, after_value)) in &after_map {
          if !before_map.contains_key(identity) {
            let item_path = child_path(path, &after_index.to_string());
            changes.push(make_change(
              context,
              "semantic",
              "add",
              None,
              Some(item_path),
              None,
              Some(after_value),
              Some(format!("array-key:{field}")),
            ));
          }
        }
      } else {
        let common = before_array.len().min(after_array.len());
        for index in 0..common {
          diff_values(
            &before_array[index],
            &after_array[index],
            &child_path(path, &index.to_string()),
            context,
            changes,
          );
        }
        for (index, before_value) in before_array.iter().enumerate().skip(common) {
          let item_path = child_path(path, &index.to_string());
          changes.push(make_change(
            context,
            "semantic",
            "remove",
            Some(item_path),
            None,
            Some(before_value),
            None,
            Some("array-index".to_string()),
          ));
        }
        for (index, after_value) in after_array.iter().enumerate().skip(common) {
          let item_path = child_path(path, &index.to_string());
          changes.push(make_change(
            context,
            "semantic",
            "add",
            None,
            Some(item_path),
            None,
            Some(after_value),
            Some("array-index".to_string()),
          ));
        }
      }
    }
    _ => changes.push(make_change(
      context,
      "semantic",
      "modify",
      Some(path.to_string()),
      Some(path.to_string()),
      Some(before),
      Some(after),
      None,
    )),
  }
}

fn source_only_changes(context: &DiffContext<'_>, semantic: &[DiffChange]) -> Vec<DiffChange> {
  let semantic_paths = semantic
    .iter()
    .flat_map(|change| [change.path_before.as_deref(), change.path_after.as_deref()])
    .flatten()
    .collect::<HashSet<_>>();
  let mut changes = Vec::new();
  for (path, before) in &context.before_nodes {
    if let Some(after) = context.after_nodes.get(path)
      && before.semantic_hash == after.semantic_hash
      && before.source_hash != after.source_hash
      && !semantic_paths.contains(path.as_str())
    {
      let kind = if before.kind == "object"
        && before
          .children
          .iter()
          .map(|child| &child.label)
          .collect::<Vec<_>>()
          != after
            .children
            .iter()
            .map(|child| &child.label)
            .collect::<Vec<_>>()
      {
        "reorder"
      } else {
        "refactor"
      };
      changes.push(make_change(
        context,
        "source-only",
        kind,
        Some(path.clone()),
        Some(path.clone()),
        None,
        None,
        Some("same-semantic-fingerprint".to_string()),
      ));
    }
  }
  changes
}

fn count_changes(changes: &[DiffChange], classification: &str, kind: Option<&str>) -> usize {
  changes
    .iter()
    .filter(|change| {
      !change.ignored
        && change.classification == classification
        && kind.is_none_or(|kind| change.kind == kind)
    })
    .count()
}

/// Compare two conf.ts source projects and their optional evaluated JSON values.
#[napi]
pub fn diff_projects(
  left: JsDiffProject,
  right: JsDiffProject,
  options: Option<JsDiffOptions>,
) -> Result<Value> {
  let options = options.unwrap_or_default();
  let before = parse_side("left", &left.filename, &left.code);
  let after = parse_side("right", &right.filename, &right.code);
  let mut diagnostics = before.diagnostics;
  diagnostics.extend(after.diagnostics);
  if let Some(error) = &left.evaluation_error {
    diagnostics.push(Diagnostic {
      side: "left".to_string(),
      severity: "error".to_string(),
      code: "evaluation-error".to_string(),
      message: error.clone(),
      location: None,
    });
  }
  if let Some(error) = &right.evaluation_error {
    diagnostics.push(Diagnostic {
      side: "right".to_string(),
      severity: "error".to_string(),
      code: "evaluation-error".to_string(),
      message: error.clone(),
      location: None,
    });
  }

  let mut before_nodes = HashMap::new();
  let mut after_nodes = HashMap::new();
  if let Some(root) = &before.root {
    flatten_nodes(root, &mut before_nodes);
  }
  if let Some(root) = &after.root {
    flatten_nodes(root, &mut after_nodes);
  }
  let array_keys = options.array_keys.unwrap_or_default();
  let redact = options.redact.unwrap_or_default();
  let mut context = DiffContext {
    array_keys: &array_keys,
    redact: &redact,
    redact_all: options.redact_all.unwrap_or(false),
    max_match_work: options.max_match_work.unwrap_or(1_000_000) as usize,
    work: 0,
    diagnostics: Vec::new(),
    before_nodes,
    after_nodes,
  };
  let mut changes = Vec::new();
  let evaluation_status = match (&left.evaluated, &right.evaluated) {
    (Some(before_value), Some(after_value)) => {
      diff_values(before_value, after_value, "", &mut context, &mut changes);
      "complete"
    }
    _ => {
      match (&before.root, &after.root) {
        (Some(before_root), Some(after_root))
          if before_root.semantic_hash != after_root.semantic_hash =>
        {
          changes.push(make_change(
            &context,
            "unknown",
            "modify",
            Some(String::new()),
            Some(String::new()),
            None,
            None,
            Some("evaluation-unavailable".to_string()),
          ));
        }
        (Some(_), None) => changes.push(make_change(
          &context,
          "unknown",
          "remove",
          Some(String::new()),
          None,
          None,
          None,
          Some("evaluation-unavailable".to_string()),
        )),
        (None, Some(_)) => changes.push(make_change(
          &context,
          "unknown",
          "add",
          None,
          Some(String::new()),
          None,
          None,
          Some("evaluation-unavailable".to_string()),
        )),
        _ => {}
      }
      "unavailable"
    }
  };
  let source_changes = source_only_changes(&context, &changes);
  changes.extend(source_changes);
  if evaluation_status == "complete"
    && !changes
      .iter()
      .any(|change| change.classification == "semantic")
    && !changes
      .iter()
      .any(|change| change.classification == "source-only")
    && before
      .root
      .as_ref()
      .zip(after.root.as_ref())
      .is_some_and(|(before, after)| before.source_hash != after.source_hash)
  {
    changes.push(make_change(
      &context,
      "source-only",
      "refactor",
      Some(String::new()),
      Some(String::new()),
      None,
      None,
      Some("same-evaluated-value".to_string()),
    ));
  }
  diagnostics.extend(context.diagnostics);
  changes.sort_by(|a, b| {
    a.path_after
      .as_deref()
      .or(a.path_before.as_deref())
      .cmp(&b.path_after.as_deref().or(b.path_before.as_deref()))
      .then(a.classification.cmp(&b.classification))
      .then(a.kind.cmp(&b.kind))
  });

  let semantic = count_changes(&changes, "semantic", None);
  let source_only = count_changes(&changes, "source-only", None);
  let unknown = count_changes(&changes, "unknown", None);
  let added = changes.iter().filter(|change| change.kind == "add").count();
  let removed = changes
    .iter()
    .filter(|change| change.kind == "remove")
    .count();
  let modified = changes
    .iter()
    .filter(|change| change.kind == "modify")
    .count();
  let moved = changes
    .iter()
    .filter(|change| change.kind == "move")
    .count();
  let renamed = changes
    .iter()
    .filter(|change| change.kind == "rename")
    .count();

  let include_source = options.include_source.unwrap_or(true);
  let before_dependencies = left.dependencies.unwrap_or_default();
  let after_dependencies = right.dependencies.unwrap_or_default();
  let dependency_nodes = before_dependencies
    .iter()
    .chain(after_dependencies.iter())
    .collect::<HashSet<_>>()
    .into_iter()
    .map(|path| {
      json!({
        "id": format!("file-{}", fnv_hash(path)),
        "path": path,
        "before": before_dependencies.contains(path),
        "after": after_dependencies.contains(path),
      })
    })
    .collect::<Vec<_>>();

  serde_json::to_value(json!({
    "schemaVersion": 1,
    "comparison": {
      "left": { "label": left.filename, "filename": left.filename },
      "right": { "label": right.filename, "filename": right.filename },
      "optionsDigest": fnv_hash(&format!("{:?}:{:?}:{}", array_keys, redact, context.max_match_work)),
    },
    "summary": {
      "total": changes.len(),
      "semantic": semantic,
      "sourceOnly": source_only,
      "unknown": unknown,
      "added": added,
      "removed": removed,
      "modified": modified,
      "moved": moved,
      "renamed": renamed,
      "evaluationStatus": evaluation_status,
    },
    "changes": changes,
    "structure": {
      "before": before.root,
      "after": after.root,
    },
    "files": [{
      "pathBefore": left.filename,
      "pathAfter": right.filename,
      "beforeSource": if include_source { Some(left.code) } else { None },
      "afterSource": if include_source { Some(right.code) } else { None },
    }],
    "dependencyGraph": {
      "nodes": dependency_nodes,
      "edges": [],
    },
    "evaluation": {
      "status": evaluation_status,
      "before": left.evaluated.map(|value| if context.redact_all { Value::String("••••••".to_string()) } else { value }),
      "after": right.evaluated.map(|value| if context.redact_all { Value::String("••••••".to_string()) } else { value }),
      "leftError": left.evaluation_error,
      "rightError": right.evaluation_error,
      "sensitive": context.redact_all,
    },
    "diagnostics": diagnostics,
  }))
  .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn project(code: &str, value: Value) -> JsDiffProject {
    JsDiffProject {
      filename: "/config.conf.ts".to_string(),
      code: code.to_string(),
      files: None,
      evaluated: Some(value),
      dependencies: None,
      evaluation_error: None,
    }
  }

  #[test]
  fn object_change_is_semantic() {
    let report = diff_projects(
      project("export default { a: 1 }", json!({ "a": 1 })),
      project("export default { a: 2 }", json!({ "a": 2 })),
      None,
    )
    .unwrap();
    assert_eq!(report["summary"]["semantic"], 1);
    assert_eq!(report["changes"][0]["pathAfter"], "/a");
  }

  #[test]
  fn object_order_is_source_only() {
    let report = diff_projects(
      project("export default { a: 1, b: 2 }", json!({ "a": 1, "b": 2 })),
      project("export default { b: 2, a: 1 }", json!({ "a": 1, "b": 2 })),
      None,
    )
    .unwrap();
    assert_eq!(report["summary"]["semantic"], 0);
    assert!(report["summary"]["sourceOnly"].as_u64().unwrap() >= 1);
  }

  #[test]
  fn keyed_array_detects_move() {
    let report = diff_projects(
      project(
        "export default [{ id: 'a' }, { id: 'b' }]",
        json!([{ "id": "a" }, { "id": "b" }]),
      ),
      project(
        "export default [{ id: 'b' }, { id: 'a' }]",
        json!([{ "id": "b" }, { "id": "a" }]),
      ),
      None,
    )
    .unwrap();
    assert_eq!(report["summary"]["moved"], 2);
  }
}
