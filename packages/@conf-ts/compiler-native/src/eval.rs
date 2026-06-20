use std::collections::{HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_span::GetSpan;

use crate::error::ConfTSError;
use crate::macro_eval::evaluate_macro;
use crate::types::{
  CompileOptions, FileContext, JsxOutputField, LineIndex, Value, normalize_number_raw,
};

const MACRO_FUNCTIONS: &[&str] = &[
  "String",
  "Number",
  "Boolean",
  "arrayMap",
  "arrayFilter",
  "arrayFlatMap",
  "env",
  "expr",
];

/// Get source location from a byte offset.
pub fn get_location(li: &LineIndex, offset: u32) -> (usize, usize) {
  li.get_location(offset)
}

pub fn module_export_name_to_string(name: &ModuleExportName) -> String {
  match name {
    ModuleExportName::IdentifierName(ident) => ident.name.as_str().to_string(),
    ModuleExportName::IdentifierReference(ident) => ident.name.as_str().to_string(),
    ModuleExportName::StringLiteral(s) => s.value.as_str().to_string(),
  }
}

fn set_object_prop(
  map: &mut Vec<(String, Value)>,
  key: String,
  value: Value,
  preserve_key_order: bool,
) {
  if preserve_key_order {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == &key) {
      entry.1 = value;
      return;
    }
    map.push((key, value));
  } else {
    map.retain(|(k, _)| k != &key);
    map.push((key, value));
  }
}

#[derive(Debug, Clone)]
enum JsxTypeFormat {
  String,
  Descriptor,
}

#[derive(Debug, Clone)]
struct NormalizedJsxOutputOptions {
  type_name: String,
  props: Option<String>,
  children: Option<String>,
  key: String,
  fragment: String,
  type_format: JsxTypeFormat,
}

#[derive(Debug, Clone)]
enum JsxTypeKind {
  Intrinsic,
  Component,
  Fragment,
}

impl JsxTypeKind {
  fn as_str(&self) -> &'static str {
    match self {
      JsxTypeKind::Intrinsic => "intrinsic",
      JsxTypeKind::Component => "component",
      JsxTypeKind::Fragment => "fragment",
    }
  }
}

#[derive(Debug, Clone)]
struct JsxTypeInfo {
  kind: JsxTypeKind,
  name: String,
}

struct EvaluatedJsxAttributes {
  props: Vec<(String, Value)>,
  key: Option<Value>,
}

fn validate_jsx_name(
  value: &str,
  field: &str,
  file_ctx: &FileContext,
  offset: u32,
) -> Result<String, ConfTSError> {
  if value.is_empty() {
    let (line, character) = get_location(&file_ctx.line_index, offset);
    return Err(ConfTSError::new(
      format!(
        "Invalid option: jsxOutput.{} must be a non-empty string",
        field
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }
  Ok(value.to_string())
}

fn validate_jsx_field(
  value: Option<&JsxOutputField>,
  field: &str,
  default_value: &str,
  file_ctx: &FileContext,
  offset: u32,
) -> Result<Option<String>, ConfTSError> {
  match value {
    None => Ok(Some(default_value.to_string())),
    Some(JsxOutputField::Name(name)) if !name.is_empty() => Ok(Some(name.clone())),
    Some(JsxOutputField::Disabled) => Ok(None),
    Some(JsxOutputField::Name(_)) | Some(JsxOutputField::InvalidBool) => {
      let (line, character) = get_location(&file_ctx.line_index, offset);
      Err(ConfTSError::new(
        format!(
          "Invalid option: jsxOutput.{} must be a non-empty string or false",
          field
        ),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

fn validate_jsx_type_format(
  value: Option<&String>,
  file_ctx: &FileContext,
  offset: u32,
) -> Result<JsxTypeFormat, ConfTSError> {
  match value.map(|v| v.as_str()) {
    None | Some("string") => Ok(JsxTypeFormat::String),
    Some("descriptor") => Ok(JsxTypeFormat::Descriptor),
    Some(_) => {
      let (line, character) = get_location(&file_ctx.line_index, offset);
      Err(ConfTSError::new(
        "Invalid option: jsxOutput.typeFormat must be \"string\" or \"descriptor\"",
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

fn normalize_jsx_output_options(
  options: &CompileOptions,
  file_ctx: &FileContext,
  offset: u32,
) -> Result<NormalizedJsxOutputOptions, ConfTSError> {
  let raw = options.jsx_output.as_ref();
  let type_name = match raw.and_then(|o| o.type_name.as_ref()) {
    Some(value) => validate_jsx_name(value, "type", file_ctx, offset)?,
    None => "type".to_string(),
  };
  let props = validate_jsx_field(
    raw.and_then(|o| o.props.as_ref()),
    "props",
    "props",
    file_ctx,
    offset,
  )?;
  let children = validate_jsx_field(
    raw.and_then(|o| o.children.as_ref()),
    "children",
    "children",
    file_ctx,
    offset,
  )?;
  let key = match raw.and_then(|o| o.key.as_ref()) {
    Some(value) => validate_jsx_name(value, "key", file_ctx, offset)?,
    None => "key".to_string(),
  };
  let fragment = match raw.and_then(|o| o.fragment.as_ref()) {
    Some(value) => validate_jsx_name(value, "fragment", file_ctx, offset)?,
    None => "Fragment".to_string(),
  };
  let type_format =
    validate_jsx_type_format(raw.and_then(|o| o.type_format.as_ref()), file_ctx, offset)?;

  let mut enabled_fields: Vec<(&str, &str)> = vec![("type", &type_name), ("key", &key)];
  if let Some(props_name) = &props {
    enabled_fields.push(("props", props_name));
  }
  if let Some(children_name) = &children {
    enabled_fields.push(("children", children_name));
  }

  let mut seen: HashMap<String, String> = HashMap::new();
  for (field, value) in enabled_fields {
    if let Some(existing) = seen.get(value) {
      let (line, character) = get_location(&file_ctx.line_index, offset);
      return Err(ConfTSError::new(
        format!(
          "Invalid option: jsxOutput.{} conflicts with jsxOutput.{} field \"{}\"",
          field, existing, value
        ),
        &file_ctx.file_path,
        line,
        character,
      ));
    }
    seen.insert(value.to_string(), field.to_string());
  }

  Ok(NormalizedJsxOutputOptions {
    type_name,
    props,
    children,
    key,
    fragment,
    type_format,
  })
}

fn get_object_prop(map: &[(String, Value)], key: &str) -> Value {
  map
    .iter()
    .find(|(k, _)| k == key)
    .map(|(_, v)| v.clone())
    .unwrap_or(Value::Undefined)
}

fn enum_object_from_decl(
  enum_decl: &TSEnumDeclaration,
  file_path: &str,
  ctx: &mut EvalContext,
) -> Value {
  let enum_name = enum_decl.id.name.as_str();
  let mut forward = Vec::new();
  let mut reverse: Vec<(String, Value)> = Vec::new();
  if let Some(file_enums) = ctx.enum_map.get(file_path) {
    for member in &enum_decl.body.members {
      let member_name = match &member.id {
        TSEnumMemberName::Identifier(ident) => ident.name.as_str().to_string(),
        TSEnumMemberName::String(s) => s.value.as_str().to_string(),
        _ => continue,
      };
      let full_name = format!("{}.{}", enum_name, member_name);
      if let Some(value) = file_enums.get(&full_name) {
        set_object_prop(&mut forward, member_name.clone(), value.clone(), false);
        if let Value::Number(n) = value {
          set_object_prop(
            &mut reverse,
            Value::number(n.value).to_display_string(),
            Value::String(member_name),
            false,
          );
        }
      }
    }
  }
  reverse.sort_by(
    |(a, _), (b, _)| match (a.parse::<u32>(), b.parse::<u32>()) {
      (Ok(a_num), Ok(b_num)) => a_num.cmp(&b_num),
      _ => a.cmp(b),
    },
  );
  let mut map = reverse;
  map.extend(forward);
  ctx.evaluated_files.insert(file_path.to_string());
  Value::Object(map)
}

/// Evaluate an expression node to a Value.
pub fn evaluate(
  expr: &Expression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  if !ctx.evaluated_files.contains(&file_ctx.file_path) {
    ctx.evaluated_files.insert(file_ctx.file_path.clone());
  }

  if options.macro_mode && !ctx.macro_imports_map.contains_key(&file_ctx.file_path) {
    let imports = collect_macro_imports(file_ctx.program(), &file_ctx.file_path);
    ctx
      .macro_imports_map
      .insert(file_ctx.file_path.clone(), imports);
  }

  match expr {
    Expression::StringLiteral(s) => Ok(Value::String(s.value.as_str().to_string())),

    Expression::NumericLiteral(n) => {
      let raw = n.raw.as_ref().map(|value| value.as_str().to_string());
      Ok(Value::number_with_raw(n.value, normalize_number_raw(raw)))
    }

    Expression::BooleanLiteral(b) => Ok(Value::Bool(b.value)),

    Expression::NullLiteral(_) => Ok(Value::Null),

    Expression::TemplateLiteral(tpl) => {
      let mut result = String::new();
      for i in 0..tpl.quasis.len() {
        if let Some(ref cooked) = tpl.quasis[i].value.cooked {
          result.push_str(cooked.as_str());
        } else {
          result.push_str(tpl.quasis[i].value.raw.as_str());
        }
        if i < tpl.expressions.len() {
          let val = evaluate(&tpl.expressions[i], file_ctx, ctx, local_context, options)?;
          result.push_str(&val.to_display_string());
        }
      }
      Ok(Value::String(result))
    }

    Expression::ObjectExpression(obj) => {
      let mut map: Vec<(String, Value)> = Vec::new();
      for prop_kind in &obj.properties {
        match prop_kind {
          ObjectPropertyKind::ObjectProperty(prop) => {
            if prop.method {
              continue;
            }
            if prop.shorthand {
              if let PropertyKey::StaticIdentifier(ident) = &prop.key {
                let name = ident.name.as_str().to_string();
                if let Some(lc) = local_context {
                  if let Some(val) = lc.get(&name) {
                    set_object_prop(&mut map, name, val.clone(), options.preserve_key_order);
                    continue;
                  }
                }
                let (line, character) = get_location(&file_ctx.line_index, prop.span.start);
                let val = resolve_identifier(
                  &name,
                  file_ctx,
                  ctx,
                  local_context,
                  options,
                  line,
                  character,
                )?;
                set_object_prop(&mut map, name, val, options.preserve_key_order);
              }
            } else {
              let key = eval_property_key(
                &prop.key,
                prop.computed,
                file_ctx,
                ctx,
                local_context,
                options,
              )?;
              let val = evaluate(&prop.value, file_ctx, ctx, local_context, options)?;
              set_object_prop(&mut map, key, val, options.preserve_key_order);
            }
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            let val = evaluate(&spread.argument, file_ctx, ctx, local_context, options)?;
            if let Value::Object(spread_map) = val {
              for (k, v) in spread_map {
                set_object_prop(&mut map, k, v, options.preserve_key_order);
              }
            }
          }
        }
      }
      Ok(Value::Object(map))
    }

    Expression::ArrayExpression(arr) => {
      let mut elements = Vec::new();
      for elem in &arr.elements {
        match elem {
          ArrayExpressionElement::SpreadElement(spread) => {
            let val = evaluate(&spread.argument, file_ctx, ctx, local_context, options)?;
            if let Value::Array(items) = val {
              elements.extend(items);
            }
          }
          ArrayExpressionElement::Elision(_) => {
            elements.push(Value::Undefined);
          }
          other => {
            if let Some(expr) = other.as_expression() {
              let val = evaluate(expr, file_ctx, ctx, local_context, options)?;
              elements.push(val);
            }
          }
        }
      }
      Ok(Value::Array(elements))
    }

    Expression::Identifier(ident) => {
      let name = ident.name.as_str();
      if name == "undefined" {
        return Ok(Value::Undefined);
      }
      if let Some(lc) = local_context {
        if let Some(val) = lc.get(name) {
          return Ok(val.clone());
        }
      }
      let (line, character) = get_location(&file_ctx.line_index, ident.span.start);
      resolve_identifier(name, file_ctx, ctx, local_context, options, line, character)
    }

    Expression::StaticMemberExpression(member) => {
      let prop_name = member.property.name.as_str().to_string();
      if member.optional {
        eval_optional_member_access(
          &member.object,
          &prop_name,
          false,
          file_ctx,
          ctx,
          local_context,
          options,
        )
      } else {
        eval_member_access(
          &member.object,
          &prop_name,
          false,
          member.span.start,
          file_ctx,
          ctx,
          local_context,
          options,
        )
      }
    }

    Expression::ComputedMemberExpression(member) => {
      let val = evaluate(&member.expression, file_ctx, ctx, local_context, options)?;
      let prop_name = val.to_display_string();
      if member.optional {
        eval_optional_member_access(
          &member.object,
          &prop_name,
          true,
          file_ctx,
          ctx,
          local_context,
          options,
        )
      } else {
        eval_member_access(
          &member.object,
          &prop_name,
          true,
          member.span.start,
          file_ctx,
          ctx,
          local_context,
          options,
        )
      }
    }

    Expression::ChainExpression(chain) => {
      eval_chain_expr(&chain.expression, file_ctx, ctx, local_context, options)
    }

    Expression::UnaryExpression(unary) => {
      if matches!(unary.operator, UnaryOperator::Typeof) {
        let operand = match evaluate(&unary.argument, file_ctx, ctx, local_context, options) {
          Ok(val) => val,
          Err(_) => Value::Undefined,
        };
        return Ok(Value::String(operand.typeof_string().to_string()));
      }
      let operand = evaluate(&unary.argument, file_ctx, ctx, local_context, options)?;
      match unary.operator {
        UnaryOperator::UnaryPlus => Ok(Value::number(operand.to_number())),
        UnaryOperator::UnaryNegation => Ok(Value::number(-operand.to_number())),
        UnaryOperator::LogicalNot => Ok(Value::Bool(!operand.is_truthy())),
        UnaryOperator::BitwiseNot => {
          let n = operand.to_number() as i32;
          Ok(Value::number((!n) as f64))
        }
        _ => {
          let (line, character) = get_location(&file_ctx.line_index, unary.span.start);
          Err(ConfTSError::new(
            format!("Unsupported unary operator: {:?}", unary.operator),
            &file_ctx.file_path,
            line,
            character,
          ))
        }
      }
    }

    Expression::LogicalExpression(log) => {
      let left = evaluate(&log.left, file_ctx, ctx, local_context, options)?;
      match log.operator {
        LogicalOperator::And => {
          if left.is_truthy() {
            evaluate(&log.right, file_ctx, ctx, local_context, options)
          } else {
            Ok(left)
          }
        }
        LogicalOperator::Or => {
          if left.is_truthy() {
            Ok(left)
          } else {
            evaluate(&log.right, file_ctx, ctx, local_context, options)
          }
        }
        LogicalOperator::Coalesce => match left {
          Value::Null | Value::Undefined => {
            evaluate(&log.right, file_ctx, ctx, local_context, options)
          }
          _ => Ok(left),
        },
      }
    }

    Expression::BinaryExpression(bin) => {
      let left = evaluate(&bin.left, file_ctx, ctx, local_context, options)?;
      let right = evaluate(&bin.right, file_ctx, ctx, local_context, options)?;
      eval_binary_op(
        bin.operator,
        left,
        right,
        &file_ctx.file_path,
        &file_ctx.line_index,
        bin.span.start,
      )
    }

    Expression::ParenthesizedExpression(paren) => {
      evaluate(&paren.expression, file_ctx, ctx, local_context, options)
    }

    Expression::TSAsExpression(ts_as) => {
      evaluate(&ts_as.expression, file_ctx, ctx, local_context, options)
    }

    Expression::TSSatisfiesExpression(ts_satisfies) => evaluate(
      &ts_satisfies.expression,
      file_ctx,
      ctx,
      local_context,
      options,
    ),

    Expression::TSNonNullExpression(ts_non_null) => {
      let val = evaluate(
        &ts_non_null.expression,
        file_ctx,
        ctx,
        local_context,
        options,
      )?;
      let (line, character) = get_location(&file_ctx.line_index, ts_non_null.span.start);
      let is_typed_nullish = is_strictly_nullish_expr(&ts_non_null.expression, file_ctx);

      if is_typed_nullish {
        Err(ConfTSError::new(
          "Non-null assertion applied to value typed as 'null' or 'undefined'",
          &file_ctx.file_path,
          line,
          character,
        ))
      } else {
        match &val {
          Value::Null | Value::Undefined => Err(ConfTSError::new(
            "Non-null assertion failed: value is null or undefined",
            &file_ctx.file_path,
            line,
            character,
          )),
          _ => Ok(val),
        }
      }
    }

    Expression::TSTypeAssertion(assertion) => {
      evaluate(&assertion.expression, file_ctx, ctx, local_context, options)
    }

    Expression::ConditionalExpression(cond) => {
      let condition = evaluate(&cond.test, file_ctx, ctx, local_context, options)?;
      if condition.is_truthy() {
        evaluate(&cond.consequent, file_ctx, ctx, local_context, options)
      } else {
        evaluate(&cond.alternate, file_ctx, ctx, local_context, options)
      }
    }

    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
      let (line, character) = get_location(&file_ctx.line_index, expr.span().start);
      Err(ConfTSError::new(
        "Unsupported type: Function",
        &file_ctx.file_path,
        line,
        character,
      ))
    }

    Expression::NewExpression(new_expr) => {
      let callee_name = expr_to_string(&new_expr.callee);
      let (line, character) = get_location(&file_ctx.line_index, new_expr.span.start);
      if callee_name == "Date" {
        Err(ConfTSError::new(
          "Unsupported type: Date",
          &file_ctx.file_path,
          line,
          character,
        ))
      } else {
        Err(ConfTSError::new(
          format!("Unsupported \"new\" expression: {}", callee_name),
          &file_ctx.file_path,
          line,
          character,
        ))
      }
    }

    Expression::CallExpression(call) => eval_call_expr(call, file_ctx, ctx, local_context, options),

    Expression::RegExpLiteral(_) => {
      let (line, character) = get_location(&file_ctx.line_index, expr.span().start);
      Err(ConfTSError::new(
        "Unsupported type: RegExp",
        &file_ctx.file_path,
        line,
        character,
      ))
    }

    Expression::JSXElement(jsx_element) => {
      evaluate_jsx_element(jsx_element, file_ctx, ctx, local_context, options)
    }

    Expression::JSXFragment(jsx_fragment) => {
      let children = evaluate_jsx_children(
        &jsx_fragment.children,
        file_ctx,
        ctx,
        local_context,
        options,
      )?;
      let jsx_output = normalize_jsx_output_options(options, file_ctx, jsx_fragment.span.start)?;
      create_jsx_node(
        JsxTypeInfo {
          kind: JsxTypeKind::Fragment,
          name: jsx_output.fragment,
        },
        EvaluatedJsxAttributes {
          props: Vec::new(),
          key: None,
        },
        children,
        file_ctx,
        jsx_fragment.span.start,
        options,
      )
    }

    Expression::SequenceExpression(seq) => {
      let mut result = Value::Undefined;
      for e in &seq.expressions {
        result = evaluate(e, file_ctx, ctx, local_context, options)?;
      }
      Ok(result)
    }

    Expression::TSInstantiationExpression(inst) => {
      evaluate(&inst.expression, file_ctx, ctx, local_context, options)
    }

    _ => {
      let (line, character) = get_location(&file_ctx.line_index, expr.span().start);
      Err(ConfTSError::new(
        format!("Unsupported syntax kind: {:?}", expr),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

/// Evaluate a call expression.
fn eval_call_expr(
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  if options.macro_mode {
    return evaluate_macro(call, file_ctx, ctx, local_context, options);
  }
  let callee = call_expr_callee_name(call);
  let (line, character) = get_location(&file_ctx.line_index, call.span.start);
  if MACRO_FUNCTIONS.contains(&callee.as_str()) {
    Err(ConfTSError::new(
      format!("Function \"{}\" is only allowed in macro mode", callee),
      &file_ctx.file_path,
      line,
      character,
    ))
  } else {
    Err(ConfTSError::new(
      format!("Unsupported call expression: {}", callee),
      &file_ctx.file_path,
      line,
      character,
    ))
  }
}

/// Evaluate a member access (shared by static, computed, and optional member expressions).
fn eval_member_access(
  obj_expr: &Expression,
  prop_name: &str,
  is_computed: bool,
  span_start: u32,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let obj_eval = evaluate(obj_expr, file_ctx, ctx, local_context, options);
  match &obj_eval {
    Ok(Value::Object(map)) => return Ok(get_object_prop(map, prop_name)),
    Ok(Value::Array(arr)) => {
      if is_computed {
        if let Ok(idx) = prop_name.parse::<usize>() {
          return Ok(arr.get(idx).cloned().unwrap_or(Value::Undefined));
        }
        return Ok(Value::Undefined);
      }
      if prop_name == "length" {
        return Ok(Value::number(arr.len() as f64));
      }
      return Ok(Value::Undefined);
    }
    Ok(Value::String(s)) => {
      if is_computed {
        if let Ok(idx) = prop_name.parse::<usize>() {
          return Ok(
            s.chars()
              .nth(idx)
              .map(|c| Value::String(c.to_string()))
              .unwrap_or(Value::Undefined),
          );
        }
        return Ok(Value::Undefined);
      }
      if prop_name == "length" {
        return Ok(Value::number(s.chars().count() as f64));
      }
      return Ok(Value::Undefined);
    }
    Ok(Value::Null) | Ok(Value::Undefined) => {
      let (line, character) = get_location(&file_ctx.line_index, span_start);
      let label = if matches!(obj_eval, Ok(Value::Null)) {
        "null"
      } else {
        "undefined"
      };
      return Err(ConfTSError::new(
        format!("Cannot read property of {}", label),
        &file_ctx.file_path,
        line,
        character,
      ));
    }
    _ => {}
  }

  // Try as enum access
  let full_name = if let Expression::Identifier(ident) = obj_expr {
    format!("{}.{}", ident.name.as_str(), prop_name)
  } else {
    String::new()
  };

  if !full_name.is_empty() {
    if let Some(file_enums) = ctx.enum_map.get(&file_ctx.file_path) {
      if let Some(val) = file_enums.get(&full_name) {
        return Ok(val.clone());
      }
    }
    for (file_path, file_enums) in &ctx.enum_map {
      if let Some(val) = file_enums.get(&full_name) {
        ctx.evaluated_files.insert(file_path.clone());
        return Ok(val.clone());
      }
    }
  }

  let obj_debug = match &obj_eval {
    Ok(Value::Object(map)) => {
      let mut keys: Vec<String> = map.iter().map(|(k, _)| k.clone()).collect();
      keys.sort();
      if keys.is_empty() {
        "object keys=[]".to_string()
      } else {
        format!("object keys=[{}]", keys.join(", "))
      }
    }
    Ok(Value::Array(arr)) => format!("array length={}", arr.len()),
    Ok(val) => format!("value={}", val.to_display_string()),
    Err(err) => format!("eval_error={}", err.message),
  };
  let enum_in_file = ctx
    .enum_map
    .get(&file_ctx.file_path)
    .map(|map| map.len())
    .unwrap_or(0);
  let enum_total: usize = ctx.enum_map.values().map(|map| map.len()).sum();
  let enum_lookup = if full_name.is_empty() {
    "skipped (non-identifier object)"
  } else {
    "checked"
  };

  let (line, character) = get_location(&file_ctx.line_index, span_start);
  Err(ConfTSError::new(
    format!(
      "Unsupported property access expression: {}.{}. Debug: obj={}, enum_lookup={}, enum_candidates={}/{}",
      expr_to_string(obj_expr),
      prop_name,
      obj_debug,
      enum_lookup,
      enum_in_file,
      enum_total
    ),
    &file_ctx.file_path,
    line,
    character,
  ))
}

/// Evaluate an optional chain expression.
fn eval_chain_expr(
  chain_elem: &ChainElement,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  match chain_elem {
    ChainElement::StaticMemberExpression(member) => {
      let prop_name = member.property.name.as_str().to_string();
      eval_optional_member_access(
        &member.object,
        &prop_name,
        false,
        file_ctx,
        ctx,
        local_context,
        options,
      )
    }
    ChainElement::ComputedMemberExpression(member) => {
      let val = evaluate(&member.expression, file_ctx, ctx, local_context, options)?;
      let prop_name = val.to_display_string();
      eval_optional_member_access(
        &member.object,
        &prop_name,
        true,
        file_ctx,
        ctx,
        local_context,
        options,
      )
    }
    ChainElement::CallExpression(call) => {
      match evaluate(&call.callee, file_ctx, ctx, local_context, options) {
        Ok(Value::Null) | Ok(Value::Undefined) => Ok(Value::Undefined),
        _ => eval_call_expr(call, file_ctx, ctx, local_context, options),
      }
    }
    ChainElement::TSNonNullExpression(ts_nn) => {
      evaluate(&ts_nn.expression, file_ctx, ctx, local_context, options)
    }
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, chain_elem.span().start);
      Err(ConfTSError::new(
        "Unsupported chain expression",
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

fn eval_optional_member_access(
  obj_expr: &Expression,
  prop_name: &str,
  is_computed: bool,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let obj = evaluate(obj_expr, file_ctx, ctx, local_context, options)?;
  match obj {
    Value::Null | Value::Undefined => Ok(Value::Undefined),
    Value::Object(map) => Ok(get_object_prop(&map, prop_name)),
    Value::Array(arr) => {
      if is_computed {
        if let Ok(idx) = prop_name.parse::<usize>() {
          return Ok(arr.get(idx).cloned().unwrap_or(Value::Undefined));
        }
      }
      if prop_name == "length" {
        return Ok(Value::number(arr.len() as f64));
      }
      Ok(Value::Undefined)
    }
    Value::String(s) => {
      if is_computed {
        if let Ok(idx) = prop_name.parse::<usize>() {
          return Ok(
            s.chars()
              .nth(idx)
              .map(|c| Value::String(c.to_string()))
              .unwrap_or(Value::Undefined),
          );
        }
      }
      if prop_name == "length" {
        return Ok(Value::number(s.chars().count() as f64));
      }
      Ok(Value::Undefined)
    }
    _ => Ok(Value::Undefined),
  }
}

/// Evaluate a binary operation.
fn eval_binary_op(
  op: BinaryOperator,
  left: Value,
  right: Value,
  file: &str,
  li: &LineIndex,
  offset: u32,
) -> Result<Value, ConfTSError> {
  match op {
    BinaryOperator::Addition => match (&left, &right) {
      (Value::String(l), _) => Ok(Value::String(format!("{}{}", l, right.to_display_string()))),
      (_, Value::String(r)) => Ok(Value::String(format!("{}{}", left.to_display_string(), r))),
      _ => Ok(Value::number(left.to_number() + right.to_number())),
    },
    BinaryOperator::Subtraction => Ok(Value::number(left.to_number() - right.to_number())),
    BinaryOperator::Multiplication => Ok(Value::number(left.to_number() * right.to_number())),
    BinaryOperator::Division => Ok(Value::number(left.to_number() / right.to_number())),
    BinaryOperator::Remainder => Ok(Value::number(left.to_number() % right.to_number())),
    BinaryOperator::Exponential => Ok(Value::number(left.to_number().powf(right.to_number()))),
    BinaryOperator::GreaterThan => Ok(Value::Bool(left.to_number() > right.to_number())),
    BinaryOperator::LessThan => Ok(Value::Bool(left.to_number() < right.to_number())),
    BinaryOperator::GreaterEqualThan => Ok(Value::Bool(left.to_number() >= right.to_number())),
    BinaryOperator::LessEqualThan => Ok(Value::Bool(left.to_number() <= right.to_number())),
    BinaryOperator::Equality => Ok(Value::Bool(left.loose_eq(&right))),
    BinaryOperator::StrictEquality => Ok(Value::Bool(left.strict_eq(&right))),
    BinaryOperator::Inequality => Ok(Value::Bool(!left.loose_eq(&right))),
    BinaryOperator::StrictInequality => Ok(Value::Bool(!left.strict_eq(&right))),
    BinaryOperator::BitwiseAnd => Ok(Value::number(
      ((left.to_number() as i32) & (right.to_number() as i32)) as f64,
    )),
    BinaryOperator::BitwiseOR => Ok(Value::number(
      ((left.to_number() as i32) | (right.to_number() as i32)) as f64,
    )),
    BinaryOperator::BitwiseXOR => Ok(Value::number(
      ((left.to_number() as i32) ^ (right.to_number() as i32)) as f64,
    )),
    BinaryOperator::ShiftLeft => Ok(Value::number(
      ((left.to_number() as i32) << ((right.to_number() as i32) & 31)) as f64,
    )),
    BinaryOperator::ShiftRight => Ok(Value::number(
      ((left.to_number() as i32) >> ((right.to_number() as i32) & 31)) as f64,
    )),
    BinaryOperator::ShiftRightZeroFill => Ok(Value::number(
      ((left.to_number() as i32 as u32) >> ((right.to_number() as i32) & 31)) as f64,
    )),
    BinaryOperator::In => {
      let key = left.to_display_string();
      match &right {
        Value::Object(map) => Ok(Value::Bool(map.iter().any(|(k, _)| k == &key))),
        Value::Array(arr) => match key.parse::<usize>() {
          Ok(idx) => Ok(Value::Bool(idx < arr.len())),
          Err(_) => Ok(Value::Bool(false)),
        },
        _ => {
          let (line, character) = get_location(li, offset);
          Err(ConfTSError::new(
            "Cannot use 'in' operator on non-object value",
            file,
            line,
            character,
          ))
        }
      }
    }
    _ => {
      let (line, character) = get_location(li, offset);
      Err(ConfTSError::new(
        format!("Unsupported binary operator: {:?}", op),
        file,
        line,
        character,
      ))
    }
  }
}

/// Evaluate a property key.
fn eval_property_key(
  key: &PropertyKey,
  computed: bool,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<String, ConfTSError> {
  if computed {
    if let Some(expr) = key.as_expression() {
      let val = evaluate(expr, file_ctx, ctx, local_context, options)?;
      return Ok(val.to_display_string());
    }
  }
  match key {
    PropertyKey::StaticIdentifier(id) => Ok(id.name.as_str().to_string()),
    PropertyKey::StringLiteral(s) => Ok(s.value.as_str().to_string()),
    PropertyKey::NumericLiteral(n) => Ok(n.value.to_string()),
    PropertyKey::BigIntLiteral(bi) => Ok(bi.value.as_str().to_string()),
    other => {
      if let Some(expr) = other.as_expression() {
        let val = evaluate(expr, file_ctx, ctx, local_context, options)?;
        Ok(val.to_display_string())
      } else {
        Ok(String::new())
      }
    }
  }
}

/// Resolve an identifier by looking up variable declarations and enums.
pub fn resolve_identifier(
  name: &str,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
  line: usize,
  character: usize,
) -> Result<Value, ConfTSError> {
  if let Some(val) = resolve_in_file(name, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }

  let mut import_debug = "none".to_string();
  if let Some(import_info) = file_ctx.imports.get(name) {
    let original_name = import_info.original_name.as_deref().unwrap_or(name);
    let resolved_path = if let Some(ref resolver) = ctx.resolver {
      resolver(&import_info.source, &file_ctx.file_path)
    } else {
      None
    };
    let mut import_context_loaded = false;

    if let Some(resolved_path) = resolved_path.clone() {
      if let Some(imported_ctx) = ctx.file_contexts.get(&resolved_path).cloned() {
        import_context_loaded = true;
        if original_name == "*" {
          return Ok(Value::Object(exported_values(&imported_ctx, ctx, options)?));
        } else if let Some(val) = resolve_in_file(original_name, &imported_ctx, ctx, None, options)?
        {
          return Ok(val);
        }
      }
    }

    import_debug = format!(
      "source={}, original={}, resolved={}, context_loaded={}",
      import_info.source,
      original_name,
      resolved_path.unwrap_or_else(|| "<unresolved>".to_string()),
      import_context_loaded
    );
  }

  let enum_in_file = ctx
    .enum_map
    .get(&file_ctx.file_path)
    .map(|map| map.len())
    .unwrap_or(0);
  let enum_total: usize = ctx.enum_map.values().map(|map| map.len()).sum();

  for (file_path, file_enums) in &ctx.enum_map {
    for (enum_key, val) in file_enums {
      if enum_key.ends_with(&format!(".{}", name)) {
        ctx.evaluated_files.insert(file_path.clone());
        return Ok(val.clone());
      }
    }
  }

  let local_keys = local_context
    .map(|ctx| {
      let mut keys: Vec<String> = ctx.keys().cloned().collect();
      keys.sort();
      if keys.is_empty() {
        "none".to_string()
      } else {
        keys.join(", ")
      }
    })
    .unwrap_or_else(|| "none".to_string());

  Err(ConfTSError::new(
    format!(
      "Unsupported variable type for identifier: {}. Debug: local_context_keys={}, import={}, enum_candidates={}/{}",
      name, local_keys, import_debug, enum_in_file, enum_total
    ),
    &file_ctx.file_path,
    line,
    character,
  ))
}

fn resolve_imported_file(
  source: &str,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
) -> Option<FileContext> {
  let resolved_path = ctx
    .resolver
    .as_ref()
    .and_then(|resolver| resolver(source, &file_ctx.file_path))?;
  ctx.file_contexts.get(&resolved_path).cloned()
}

/// Try to resolve a name from direct declarations in a file.
fn resolve_declared_in_file(
  name: &str,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if name == "default" {
    for stmt in &file_ctx.program().body {
      if let Statement::ExportDefaultDeclaration(export) = stmt {
        if let Some(expr) = export.declaration.as_expression() {
          let val = evaluate(expr, file_ctx, ctx, local_context, options)?;
          return Ok(Some(val));
        } else {
          let (line, character) = get_location(&file_ctx.line_index, export.span.start);
          return Err(ConfTSError::new(
            "Unsupported default export declaration",
            &file_ctx.file_path,
            line,
            character,
          ));
        }
      }
    }
  }
  for stmt in &file_ctx.program().body {
    match stmt {
      Statement::VariableDeclaration(var_decl) => {
        if let Some(result) = check_var_decl(name, var_decl, file_ctx, ctx, local_context, options)?
        {
          return Ok(Some(result));
        }
      }
      Statement::ExportNamedDeclaration(export_decl) => match &export_decl.declaration {
        Some(Declaration::VariableDeclaration(var_decl)) => {
          if let Some(result) =
            check_var_decl(name, var_decl, file_ctx, ctx, local_context, options)?
          {
            return Ok(Some(result));
          }
        }
        Some(Declaration::TSEnumDeclaration(enum_decl)) if enum_decl.id.name.as_str() == name => {
          return Ok(Some(enum_object_from_decl(
            enum_decl.as_ref(),
            &file_ctx.file_path,
            ctx,
          )));
        }
        _ => {}
      },
      Statement::TSEnumDeclaration(enum_decl) if enum_decl.id.name.as_str() == name => {
        return Ok(Some(enum_object_from_decl(
          enum_decl.as_ref(),
          &file_ctx.file_path,
          ctx,
        )));
      }
      _ => {}
    }
  }
  Ok(None)
}

/// Try to resolve a name within a file's declarations and re-exports.
pub fn resolve_in_file(
  name: &str,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if let Some(result) = resolve_declared_in_file(name, file_ctx, ctx, local_context, options)? {
    return Ok(Some(result));
  }

  for stmt in &file_ctx.program().body {
    match stmt {
      Statement::ExportNamedDeclaration(named_export) => {
        for specifier in &named_export.specifiers {
          let exported_name = module_export_name_to_string(&specifier.exported);
          if exported_name != name {
            continue;
          }
          let original_name = module_export_name_to_string(&specifier.local);
          if let Some(src) = &named_export.source {
            if let Some(imported_ctx) = resolve_imported_file(src.value.as_str(), file_ctx, ctx) {
              return resolve_in_file(&original_name, &imported_ctx, ctx, None, options);
            }
          } else {
            return resolve_declared_in_file(&original_name, file_ctx, ctx, local_context, options);
          }
        }
      }
      Statement::ExportAllDeclaration(export_all) => {
        if name == "default" {
          continue;
        }
        if let Some(imported_ctx) =
          resolve_imported_file(export_all.source.value.as_str(), file_ctx, ctx)
        {
          if let Some(result) = resolve_in_file(name, &imported_ctx, ctx, None, options)? {
            return Ok(Some(result));
          }
        }
      }
      _ => {}
    }
  }

  Ok(None)
}

fn exported_values(
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<Vec<(String, Value)>, ConfTSError> {
  let mut exports = Vec::new();

  for stmt in &file_ctx.program().body {
    match stmt {
      Statement::ExportDefaultDeclaration(export) => {
        if let Some(expr) = export.declaration.as_expression() {
          let val = evaluate(expr, file_ctx, ctx, None, options)?;
          set_object_prop(
            &mut exports,
            "default".to_string(),
            val,
            options.preserve_key_order,
          );
        }
      }
      Statement::ExportNamedDeclaration(export_decl) => {
        match &export_decl.declaration {
          Some(Declaration::VariableDeclaration(var_decl)) => {
            for decl in &var_decl.declarations {
              if let BindingPattern::BindingIdentifier(ident) = &decl.id {
                let name = ident.name.as_str().to_string();
                if let Some(val) = resolve_declared_in_file(&name, file_ctx, ctx, None, options)? {
                  set_object_prop(&mut exports, name, val, options.preserve_key_order);
                }
              }
            }
          }
          Some(Declaration::TSEnumDeclaration(enum_decl)) => {
            let name = enum_decl.id.name.as_str().to_string();
            let val = enum_object_from_decl(enum_decl.as_ref(), &file_ctx.file_path, ctx);
            set_object_prop(&mut exports, name, val, options.preserve_key_order);
          }
          _ => {}
        }
        for specifier in &export_decl.specifiers {
          let original_name = module_export_name_to_string(&specifier.local);
          let exported_name = module_export_name_to_string(&specifier.exported);
          let val = if let Some(src) = &export_decl.source {
            resolve_imported_file(src.value.as_str(), file_ctx, ctx)
              .map(|imported_ctx| {
                resolve_in_file(&original_name, &imported_ctx, ctx, None, options)
              })
              .transpose()?
              .flatten()
          } else {
            resolve_declared_in_file(&original_name, file_ctx, ctx, None, options)?
          };
          if let Some(val) = val {
            set_object_prop(&mut exports, exported_name, val, options.preserve_key_order);
          }
        }
      }
      Statement::ExportAllDeclaration(export_all) => {
        if let Some(imported_ctx) =
          resolve_imported_file(export_all.source.value.as_str(), file_ctx, ctx)
        {
          for (key, val) in exported_values(&imported_ctx, ctx, options)? {
            if key != "default" {
              set_object_prop(&mut exports, key, val, options.preserve_key_order);
            }
          }
        }
      }
      _ => {}
    }
  }

  Ok(exports)
}

fn check_var_decl(
  name: &str,
  var_decl: &VariableDeclaration,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if var_decl.kind != VariableDeclarationKind::Const {
    for decl in &var_decl.declarations {
      if let BindingPattern::BindingIdentifier(ident) = &decl.id {
        if ident.name.as_str() == name {
          let kind = match var_decl.kind {
            VariableDeclarationKind::Let => "let",
            VariableDeclarationKind::Var => "var",
            _ => unreachable!(),
          };
          return Err(ConfTSError::new(
            format!(
              "Failed to evaluate variable \"{}\". Only 'const' declarations are supported, but it was declared with '{}'.",
              name, kind
            ),
            &file_ctx.file_path,
            1,
            1,
          ));
        }
      }
    }
    return Ok(None);
  }
  for decl in &var_decl.declarations {
    match &decl.id {
      BindingPattern::BindingIdentifier(ident) if ident.name.as_str() == name => {
        if let Some(ref init) = decl.init {
          let val = evaluate(init, file_ctx, ctx, local_context, options)?;
          return Ok(Some(val));
        }
      }
      BindingPattern::ObjectPattern(obj_pat) => {
        if let Some(ref init) = decl.init {
          if let Some(val) =
            resolve_destructured(name, obj_pat, init, file_ctx, ctx, local_context, options)?
          {
            return Ok(Some(val));
          }
        }
      }
      BindingPattern::ArrayPattern(arr_pat) => {
        if let Some(ref init) = decl.init {
          if let Some(val) =
            resolve_array_destructured(name, arr_pat, init, file_ctx, ctx, local_context, options)?
          {
            return Ok(Some(val));
          }
        }
      }
      _ => {}
    }
  }
  Ok(None)
}

fn resolve_array_destructured(
  name: &str,
  arr_pat: &ArrayPattern,
  init: &Expression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  let source = evaluate(init, file_ctx, ctx, local_context, options)?;
  resolve_array_pattern_value(name, arr_pat, source, file_ctx, ctx, local_context, options)
}

fn resolve_destructured(
  name: &str,
  obj_pat: &ObjectPattern,
  init: &Expression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  let source_obj = evaluate(init, file_ctx, ctx, local_context, options)?;
  resolve_object_pattern_value(
    name,
    obj_pat,
    source_obj,
    file_ctx,
    ctx,
    local_context,
    options,
  )
}

fn resolve_pattern_value(
  name: &str,
  pat: &BindingPattern,
  value: Value,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  match pat {
    BindingPattern::BindingIdentifier(bind_ident) => {
      if bind_ident.name.as_str() == name {
        Ok(Some(value))
      } else {
        Ok(None)
      }
    }
    BindingPattern::ObjectPattern(obj_pat) => {
      resolve_object_pattern_value(name, obj_pat, value, file_ctx, ctx, local_context, options)
    }
    BindingPattern::ArrayPattern(arr_pat) => {
      resolve_array_pattern_value(name, arr_pat, value, file_ctx, ctx, local_context, options)
    }
    BindingPattern::AssignmentPattern(assign) => {
      let actual = if matches!(value, Value::Undefined) {
        evaluate(&assign.right, file_ctx, ctx, local_context, options)?
      } else {
        value
      };
      resolve_pattern_value(
        name,
        &assign.left,
        actual,
        file_ctx,
        ctx,
        local_context,
        options,
      )
    }
  }
}

fn resolve_array_pattern_value(
  name: &str,
  arr_pat: &ArrayPattern,
  source: Value,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  let items = match source {
    Value::Array(items) => items,
    _ => Vec::new(),
  };
  for (idx, elem) in arr_pat.elements.iter().enumerate() {
    let Some(pat) = elem else {
      continue;
    };
    let value = items.get(idx).cloned().unwrap_or(Value::Undefined);
    if let Some(resolved) =
      resolve_pattern_value(name, pat, value, file_ctx, ctx, local_context, options)?
    {
      return Ok(Some(resolved));
    }
  }
  if let Some(rest) = &arr_pat.rest {
    let rest_items = if arr_pat.elements.len() >= items.len() {
      Vec::new()
    } else {
      items[arr_pat.elements.len()..].to_vec()
    };
    if let Some(resolved) = resolve_pattern_value(
      name,
      &rest.argument,
      Value::Array(rest_items),
      file_ctx,
      ctx,
      local_context,
      options,
    )? {
      return Ok(Some(resolved));
    }
  }
  Ok(None)
}

fn resolve_object_pattern_value(
  name: &str,
  obj_pat: &ObjectPattern,
  source_obj: Value,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  let map = match source_obj {
    Value::Object(map) => map,
    _ => Vec::new(),
  };
  for prop in &obj_pat.properties {
    if prop.shorthand {
      if let PropertyKey::StaticIdentifier(key_ident) = &prop.key {
        let key = key_ident.name.as_str();
        let value = get_object_prop(&map, key);
        if let Some(resolved) = resolve_pattern_value(
          name,
          &prop.value,
          value,
          file_ctx,
          ctx,
          local_context,
          options,
        )? {
          return Ok(Some(resolved));
        }
      }
    } else {
      let key = eval_property_key(
        &prop.key,
        prop.computed,
        file_ctx,
        ctx,
        local_context,
        options,
      )?;
      let value = get_object_prop(&map, &key);
      if let Some(resolved) = resolve_pattern_value(
        name,
        &prop.value,
        value,
        file_ctx,
        ctx,
        local_context,
        options,
      )? {
        return Ok(Some(resolved));
      }
    }
  }
  if let Some(rest) = &obj_pat.rest {
    let mut keys_to_remove = HashSet::new();
    for p in &obj_pat.properties {
      if p.shorthand {
        if let PropertyKey::StaticIdentifier(key_ident) = &p.key {
          keys_to_remove.insert(key_ident.name.as_str().to_string());
        }
      } else {
        if let Ok(key) =
          eval_property_key(&p.key, p.computed, file_ctx, ctx, local_context, options)
        {
          keys_to_remove.insert(key);
        }
      }
    }
    let rest_obj: Vec<(String, Value)> = map
      .iter()
      .filter(|(k, _)| !keys_to_remove.contains(k))
      .map(|(k, v)| (k.clone(), v.clone()))
      .collect();
    if let Some(resolved) = resolve_pattern_value(
      name,
      &rest.argument,
      Value::Object(rest_obj),
      file_ctx,
      ctx,
      local_context,
      options,
    )? {
      return Ok(Some(resolved));
    }
  }
  Ok(None)
}

/// Convert an expression to a display string (for error messages).
pub fn expr_to_string(expr: &Expression) -> String {
  match expr {
    Expression::Identifier(ident) => ident.name.as_str().to_string(),
    Expression::StaticMemberExpression(member) => {
      let obj = expr_to_string(&member.object);
      format!("{}.{}", obj, member.property.name.as_str())
    }
    Expression::ComputedMemberExpression(member) => {
      let obj = expr_to_string(&member.object);
      format!("{}[...]", obj)
    }
    _ => "<expression>".to_string(),
  }
}

/// Get the callee name from a call expression.
pub fn call_expr_callee_name(call: &CallExpression) -> String {
  expr_to_string(&call.callee)
}

/// Collect macro imports from a program's import declarations.
pub fn collect_macro_imports(program: &Program, _file_path: &str) -> HashSet<String> {
  let mut imports = HashSet::new();
  for stmt in &program.body {
    if let Statement::ImportDeclaration(import_decl) = stmt {
      let module_specifier = import_decl.source.value.as_str();
      if module_specifier == "@conf-ts/macro" {
        if let Some(specifiers) = &import_decl.specifiers {
          for specifier in specifiers {
            if let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier {
              imports.insert(named.local.name.as_str().to_string());
            }
          }
        }
      }
    }
  }
  imports
}

/// Import info for a named import.
#[derive(Debug, Clone)]
pub struct ImportInfo {
  pub source: String,
  pub original_name: Option<String>,
}

/// Collect all imports from a program.
pub fn collect_imports(program: &Program) -> HashMap<String, ImportInfo> {
  let mut imports = HashMap::new();
  let mut export_source_index = 0;
  for stmt in &program.body {
    match stmt {
      Statement::ImportDeclaration(import_decl) => {
        let source = import_decl.source.value.as_str().to_string();
        if let Some(specifiers) = &import_decl.specifiers {
          for specifier in specifiers {
            match specifier {
              ImportDeclarationSpecifier::ImportSpecifier(named) => {
                let local_name = named.local.name.as_str().to_string();
                let original_name = Some(module_export_name_to_string(&named.imported));
                imports.insert(
                  local_name,
                  ImportInfo {
                    source: source.clone(),
                    original_name,
                  },
                );
              }
              ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                imports.insert(
                  default.local.name.as_str().to_string(),
                  ImportInfo {
                    source: source.clone(),
                    original_name: Some("default".to_string()),
                  },
                );
              }
              ImportDeclarationSpecifier::ImportNamespaceSpecifier(ns) => {
                imports.insert(
                  ns.local.name.as_str().to_string(),
                  ImportInfo {
                    source: source.clone(),
                    original_name: Some("*".to_string()),
                  },
                );
              }
            }
          }
        }
      }
      Statement::ExportNamedDeclaration(named_export) => {
        if let Some(src) = &named_export.source {
          imports.insert(
            format!("__conf_ts_export_source_{}", export_source_index),
            ImportInfo {
              source: src.value.as_str().to_string(),
              original_name: None,
            },
          );
          export_source_index += 1;
        }
      }
      Statement::ExportAllDeclaration(export_all) => {
        imports.insert(
          format!("__conf_ts_export_source_{}", export_source_index),
          ImportInfo {
            source: export_all.source.value.as_str().to_string(),
            original_name: None,
          },
        );
        export_source_index += 1;
      }
      _ => {}
    }
  }
  imports
}

/// Evaluation context shared across all files during compilation.
pub struct EvalContext {
  pub enum_map: HashMap<String, HashMap<String, Value>>,
  pub macro_imports_map: HashMap<String, HashSet<String>>,
  pub evaluated_files: HashSet<String>,
  pub file_contexts: HashMap<String, FileContext>,
  pub resolver: Option<Box<dyn Fn(&str, &str) -> Option<String>>>,
}

fn is_strictly_nullish_expr(expr: &Expression, file_ctx: &FileContext) -> bool {
  match expr {
    Expression::NullLiteral(_) => true,
    Expression::Identifier(ident) if ident.name.as_str() == "undefined" => true,
    Expression::Identifier(ident) => {
      for stmt in &file_ctx.program().body {
        match stmt {
          Statement::ExportNamedDeclaration(export_decl) => {
            if let Some(Declaration::VariableDeclaration(var_decl)) = &export_decl.declaration {
              if let Some(type_ann) = find_type_ann_in_var_decl(ident.name.as_str(), var_decl) {
                return is_nullish_type(type_ann);
              }
            }
          }
          Statement::VariableDeclaration(var_decl) => {
            if let Some(type_ann) = find_type_ann_in_var_decl(ident.name.as_str(), var_decl) {
              return is_nullish_type(type_ann);
            }
          }
          _ => {}
        }
      }
      false
    }
    Expression::TSAsExpression(ts_as) => is_nullish_type(&ts_as.type_annotation),
    Expression::TSSatisfiesExpression(ts_sat) => is_nullish_type(&ts_sat.type_annotation),
    Expression::ParenthesizedExpression(paren) => {
      is_strictly_nullish_expr(&paren.expression, file_ctx)
    }
    _ => false,
  }
}

fn find_type_ann_in_var_decl<'a>(
  name: &str,
  var_decl: &'a VariableDeclaration<'a>,
) -> Option<&'a TSType<'a>> {
  for decl in &var_decl.declarations {
    if let BindingPattern::BindingIdentifier(binding_ident) = &decl.id {
      if binding_ident.name.as_str() == name {
        return decl.type_annotation.as_ref().map(|at| &at.type_annotation);
      }
    }
  }
  None
}

fn is_nullish_type(t: &TSType) -> bool {
  match t {
    TSType::TSNullKeyword(_) => true,
    TSType::TSUndefinedKeyword(_) => true,
    TSType::TSUnionType(ut) => ut.types.iter().all(|sub_t| is_nullish_type(sub_t)),
    TSType::TSParenthesizedType(pt) => is_nullish_type(&pt.type_annotation),
    _ => false,
  }
}

fn clean_jsx_text(raw: &str) -> Option<String> {
  let lines: Vec<&str> = raw.split('\n').collect();
  let mut last_non_empty: i32 = -1;
  for (i, line) in lines.iter().enumerate() {
    if line.chars().any(|c| c != ' ' && c != '\t' && c != '\r') {
      last_non_empty = i as i32;
    }
  }
  if last_non_empty < 0 {
    return None;
  }
  let last_non_empty = last_non_empty as usize;
  let mut result = String::new();
  for (i, line) in lines.iter().enumerate() {
    let mut processed = line.replace('\t', " ").replace('\r', "");
    if i > 0 {
      processed = processed.trim_start().to_string();
    }
    if i < lines.len() - 1 {
      processed = processed.trim_end().to_string();
    }
    if !processed.is_empty() {
      if !result.is_empty() && i <= last_non_empty {
        result.push(' ');
      }
      result.push_str(&processed);
    }
  }
  if result.is_empty() {
    None
  } else {
    Some(result)
  }
}

fn jsx_child_value(children: Vec<Value>) -> Value {
  if children.len() == 1 {
    children.into_iter().next().unwrap()
  } else {
    Value::Array(children)
  }
}

fn jsx_member_object_name(obj: &JSXMemberExpressionObject) -> String {
  match obj {
    JSXMemberExpressionObject::IdentifierReference(ident) => ident.name.as_str().to_string(),
    JSXMemberExpressionObject::MemberExpression(member) => jsx_member_name(member),
    JSXMemberExpressionObject::ThisExpression(_) => "this".to_string(),
  }
}

fn jsx_member_name(member: &JSXMemberExpression) -> String {
  format!(
    "{}.{}",
    jsx_member_object_name(&member.object),
    member.property.name.as_str()
  )
}

fn get_jsx_element_type(name: &JSXElementName) -> JsxTypeInfo {
  match name {
    JSXElementName::Identifier(ident) => JsxTypeInfo {
      kind: JsxTypeKind::Intrinsic,
      name: ident.name.as_str().to_string(),
    },
    JSXElementName::IdentifierReference(ident) => JsxTypeInfo {
      kind: JsxTypeKind::Component,
      name: ident.name.as_str().to_string(),
    },
    JSXElementName::MemberExpression(member) => JsxTypeInfo {
      kind: JsxTypeKind::Component,
      name: jsx_member_name(member),
    },
    JSXElementName::NamespacedName(ns) => JsxTypeInfo {
      kind: JsxTypeKind::Intrinsic,
      name: format!("{}:{}", ns.namespace.name.as_str(), ns.name.name.as_str()),
    },
    JSXElementName::ThisExpression(_) => JsxTypeInfo {
      kind: JsxTypeKind::Component,
      name: "this".to_string(),
    },
  }
}

fn format_jsx_type(type_info: &JsxTypeInfo, jsx_output: &NormalizedJsxOutputOptions) -> Value {
  match jsx_output.type_format {
    JsxTypeFormat::String => Value::String(type_info.name.clone()),
    JsxTypeFormat::Descriptor => Value::Object(vec![
      (
        "kind".to_string(),
        Value::String(type_info.kind.as_str().to_string()),
      ),
      ("name".to_string(), Value::String(type_info.name.clone())),
    ]),
  }
}

fn assert_no_flat_jsx_prop_collision(
  props: &[(String, Value)],
  jsx_output: &NormalizedJsxOutputOptions,
  file_ctx: &FileContext,
  offset: u32,
) -> Result<(), ConfTSError> {
  let mut protected_fields: HashSet<String> = HashSet::new();
  protected_fields.insert(jsx_output.type_name.clone());
  protected_fields.insert(jsx_output.key.clone());
  if let Some(children_name) = &jsx_output.children {
    protected_fields.insert(children_name.clone());
  }

  for (key, _) in props {
    if protected_fields.contains(key) {
      let (line, character) = get_location(&file_ctx.line_index, offset);
      return Err(ConfTSError::new(
        format!(
          "JSX prop \"{}\" conflicts with JSX output field \"{}\"",
          key, key
        ),
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  }
  Ok(())
}

fn create_jsx_node(
  type_info: JsxTypeInfo,
  attrs: EvaluatedJsxAttributes,
  children: Vec<Value>,
  file_ctx: &FileContext,
  offset: u32,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let jsx_output = normalize_jsx_output_options(options, file_ctx, offset)?;
  let output_type = format_jsx_type(&type_info, &jsx_output);

  if jsx_output.props.is_none() {
    assert_no_flat_jsx_prop_collision(&attrs.props, &jsx_output, file_ctx, offset)?;
    let mut output = vec![(jsx_output.type_name, output_type)];
    for (key, value) in attrs.props {
      set_object_prop(&mut output, key, value, options.preserve_key_order);
    }
    if let Some(key_value) = attrs.key {
      set_object_prop(
        &mut output,
        jsx_output.key,
        key_value,
        options.preserve_key_order,
      );
    }
    if !children.is_empty() {
      if let Some(children_name) = jsx_output.children {
        set_object_prop(
          &mut output,
          children_name,
          jsx_child_value(children),
          options.preserve_key_order,
        );
      }
    }
    return Ok(Value::Object(output));
  }

  let mut props = attrs.props;
  if let Some(key_value) = attrs.key {
    set_object_prop(
      &mut props,
      jsx_output.key,
      key_value,
      options.preserve_key_order,
    );
  }
  if !children.is_empty() {
    if let Some(children_name) = &jsx_output.children {
      set_object_prop(
        &mut props,
        children_name.clone(),
        jsx_child_value(children),
        options.preserve_key_order,
      );
    }
  }

  Ok(Value::Object(vec![
    (jsx_output.type_name, output_type),
    (jsx_output.props.unwrap(), Value::Object(props)),
  ]))
}

fn meaningful_jsx_child_pos(child: &JSXChild) -> Option<u32> {
  match child {
    JSXChild::Text(text) => clean_jsx_text(text.value.as_str()).map(|_| text.span.start),
    JSXChild::ExpressionContainer(expr_container) => match &expr_container.expression {
      JSXExpression::EmptyExpression(_) => None,
      _ => Some(expr_container.span.start),
    },
    JSXChild::Element(el) => Some(el.opening_element.span.start),
    JSXChild::Fragment(frag) => {
      if frag
        .children
        .iter()
        .any(|child| meaningful_jsx_child_pos(child).is_some())
      {
        Some(frag.span.start)
      } else {
        None
      }
    }
    JSXChild::Spread(spread) => Some(spread.span.start),
  }
}

fn evaluate_jsx_element(
  element: &JSXElement,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let type_info = get_jsx_element_type(&element.opening_element.name);

  let props = evaluate_jsx_attributes(
    &element.opening_element.attributes,
    file_ctx,
    ctx,
    local_context,
    options,
    element.opening_element.span.start,
  )?;

  let children = evaluate_jsx_children(&element.children, file_ctx, ctx, local_context, options)?;
  create_jsx_node(
    type_info,
    props,
    children,
    file_ctx,
    element.opening_element.span.start,
    options,
  )
}

fn evaluate_jsx_attributes(
  attrs: &[JSXAttributeItem],
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
  offset: u32,
) -> Result<EvaluatedJsxAttributes, ConfTSError> {
  let jsx_output = normalize_jsx_output_options(options, file_ctx, offset)?;
  let mut props: Vec<(String, Value)> = Vec::new();
  let mut key: Option<Value> = None;
  for attr in attrs {
    match attr {
      JSXAttributeItem::Attribute(jsx_attr) => {
        let name = match &jsx_attr.name {
          JSXAttributeName::Identifier(ident) => ident.name.as_str().to_string(),
          JSXAttributeName::NamespacedName(ns) => {
            format!("{}:{}", ns.namespace.name.as_str(), ns.name.name.as_str())
          }
        };
        let value = match &jsx_attr.value {
          None => Value::Bool(true),
          Some(JSXAttributeValue::StringLiteral(s)) => Value::String(s.value.as_str().to_string()),
          Some(JSXAttributeValue::ExpressionContainer(expr_container)) => {
            match &expr_container.expression {
              JSXExpression::EmptyExpression(_) => Value::Undefined,
              other => {
                if let Some(expr) = other.as_expression() {
                  evaluate(expr, file_ctx, ctx, local_context, options)?
                } else {
                  Value::Undefined
                }
              }
            }
          }
          Some(JSXAttributeValue::Element(el)) => {
            evaluate_jsx_element(el, file_ctx, ctx, local_context, options)?
          }
          Some(JSXAttributeValue::Fragment(frag)) => {
            let children =
              evaluate_jsx_children(&frag.children, file_ctx, ctx, local_context, options)?;
            let jsx_output = normalize_jsx_output_options(options, file_ctx, frag.span.start)?;
            create_jsx_node(
              JsxTypeInfo {
                kind: JsxTypeKind::Fragment,
                name: jsx_output.fragment,
              },
              EvaluatedJsxAttributes {
                props: Vec::new(),
                key: None,
              },
              children,
              file_ctx,
              frag.span.start,
              options,
            )?
          }
        };
        if name == "key" {
          key = Some(value);
        } else {
          set_object_prop(&mut props, name, value, options.preserve_key_order);
        }
      }
      JSXAttributeItem::SpreadAttribute(spread) => {
        let val = evaluate(&spread.argument, file_ctx, ctx, local_context, options)?;
        if let Value::Object(spread_map) = val {
          for (k, v) in spread_map {
            set_object_prop(&mut props, k, v, options.preserve_key_order);
          }
        }
      }
    }
  }
  if let Some(value) = key.take() {
    if jsx_output.props.is_some() {
      set_object_prop(
        &mut props,
        jsx_output.key,
        value,
        options.preserve_key_order,
      );
      return Ok(EvaluatedJsxAttributes { props, key: None });
    }
    key = Some(value);
  }
  Ok(EvaluatedJsxAttributes { props, key })
}

fn evaluate_jsx_children(
  children: &[JSXChild],
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Vec<Value>, ConfTSError> {
  let jsx_output = normalize_jsx_output_options(options, file_ctx, 0)?;
  if jsx_output.children.is_none() {
    if let Some(pos) = children.iter().find_map(meaningful_jsx_child_pos) {
      let (line, character) = get_location(&file_ctx.line_index, pos);
      return Err(ConfTSError::new(
        "JSX children are disabled by jsxOutput.children: false",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
    return Ok(Vec::new());
  }

  let mut result = Vec::new();
  for child in children {
    match child {
      JSXChild::Text(text) => {
        if let Some(cleaned) = clean_jsx_text(text.value.as_str()) {
          result.push(Value::String(cleaned));
        }
      }
      JSXChild::ExpressionContainer(expr_container) => match &expr_container.expression {
        JSXExpression::EmptyExpression(_) => {}
        other => {
          if let Some(expr) = other.as_expression() {
            result.push(evaluate(expr, file_ctx, ctx, local_context, options)?);
          }
        }
      },
      JSXChild::Element(el) => {
        result.push(evaluate_jsx_element(
          el,
          file_ctx,
          ctx,
          local_context,
          options,
        )?);
      }
      JSXChild::Fragment(frag) => {
        let children =
          evaluate_jsx_children(&frag.children, file_ctx, ctx, local_context, options)?;
        let jsx_output = normalize_jsx_output_options(options, file_ctx, frag.span.start)?;
        result.push(create_jsx_node(
          JsxTypeInfo {
            kind: JsxTypeKind::Fragment,
            name: jsx_output.fragment,
          },
          EvaluatedJsxAttributes {
            props: Vec::new(),
            key: None,
          },
          children,
          file_ctx,
          frag.span.start,
          options,
        )?);
      }
      JSXChild::Spread(spread) => {
        let val = evaluate(&spread.expression, file_ctx, ctx, local_context, options)?;
        if let Value::Array(items) = val {
          result.extend(items);
        }
      }
    }
  }
  Ok(result)
}

impl EvalContext {
  pub fn new() -> Self {
    Self {
      enum_map: HashMap::new(),
      macro_imports_map: HashMap::new(),
      evaluated_files: HashSet::new(),
      file_contexts: HashMap::new(),
      resolver: None,
    }
  }
}

/// Find and evaluate the default export from an entry file.
pub fn find_default_export(
  entry_ctx: &FileContext,
  eval_ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  for stmt in &entry_ctx.program().body {
    match stmt {
      Statement::ExportDefaultDeclaration(export) => {
        if let Some(expr) = export.declaration.as_expression() {
          return evaluate(expr, entry_ctx, eval_ctx, None, options);
        } else {
          let (line, character) = entry_ctx.line_index.get_location(export.span.start);
          return Err(ConfTSError::new(
            "Unsupported default export declaration",
            &entry_ctx.file_path,
            line,
            character,
          ));
        }
      }
      Statement::ExportNamedDeclaration(named_export) => {
        for specifier in &named_export.specifiers {
          let original_name = module_export_name_to_string(&specifier.local);
          let exported_name = module_export_name_to_string(&specifier.exported);
          if exported_name != "default" {
            continue;
          }
          eval_ctx.evaluated_files.insert(entry_ctx.file_path.clone());
          let target_ctx = match &named_export.source {
            Some(src) => {
              let resolved = eval_ctx
                .resolver
                .as_ref()
                .and_then(|r| r(src.value.as_str(), &entry_ctx.file_path));
              resolved.and_then(|path| eval_ctx.file_contexts.get(&path).cloned())
            }
            None => Some(entry_ctx.clone()),
          };
          if let Some(target_ctx) = target_ctx {
            if let Some(value) =
              resolve_in_file(&original_name, &target_ctx, eval_ctx, None, options)?
            {
              return Ok(value);
            }
          }
        }
      }
      _ => {}
    }
  }

  Err(ConfTSError::new(
    format!(
      "No default export found in the entry file: {}",
      entry_ctx.file_path
    ),
    &entry_ctx.file_path,
    1,
    1,
  ))
}
