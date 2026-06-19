use std::collections::HashMap;

use oxc_ast::ast::*;
use oxc_span::GetSpan;

use crate::error::ConfTSError;
use crate::eval::{EvalContext, call_expr_callee_name, evaluate, get_location};
use crate::types::{CompileOptions, FileContext, Value};

/// Evaluate a macro call expression.
pub fn evaluate_macro(
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let callee = call_expr_callee_name(call);

  if let Some(val) = evaluate_type_casting(&callee, call, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }
  if let Some(val) = evaluate_array_map(&callee, call, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }
  if let Some(val) = evaluate_array_flat_map(&callee, call, file_ctx, ctx, local_context, options)?
  {
    return Ok(val);
  }
  if let Some(val) = evaluate_array_filter(&callee, call, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }
  if let Some(val) = evaluate_env(&callee, call, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }

  let (line, character) = get_location(&file_ctx.line_index, call.span.start);
  Err(ConfTSError::new(
    format!("Unsupported call expression in macro mode: {}", callee),
    &file_ctx.file_path,
    line,
    character,
  ))
}

fn check_macro_import(callee: &str, ctx: &EvalContext, file_path: &str) -> bool {
  ctx
    .macro_imports_map
    .get(file_path)
    .is_some_and(|imports| imports.contains(callee))
}

fn evaluate_type_casting(
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "String" && callee != "Number" && callee != "Boolean" {
    return Ok(None);
  }
  if call.arguments.len() != 1 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.line_index, call.span.start);
    return Err(ConfTSError::new(
      format!(
        "Type casting function '{}' must be imported from '@conf-ts/macro' to use in macro mode",
        callee
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let arg_expr = call.arguments[0].as_expression().unwrap();
  let arg = evaluate(arg_expr, file_ctx, ctx, local_context, options)?;
  match callee {
    "String" => Ok(Some(Value::String(arg.to_display_string()))),
    "Number" => Ok(Some(Value::number(arg.to_number()))),
    "Boolean" => Ok(Some(Value::Bool(arg.is_truthy()))),
    _ => Ok(None),
  }
}

fn evaluate_env(
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "env" {
    return Ok(None);
  }
  if call.arguments.len() != 1 && call.arguments.len() != 2 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.line_index, call.span.start);
    return Err(ConfTSError::new(
      format!(
        "Macro function '{}' must be imported from '@conf-ts/macro' to use in macro mode",
        callee
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let arg0_expr = call.arguments[0].as_expression().unwrap();
  let arg = evaluate(arg0_expr, file_ctx, ctx, local_context, options)?;
  let env_key = match &arg {
    Value::String(s) => s.clone(),
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, arg0_expr.span().start);
      return Err(ConfTSError::new(
        "env macro argument must be a string",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  let default_value = if call.arguments.len() == 2 {
    let arg1_expr = call.arguments[1].as_expression().unwrap();
    let val = evaluate(arg1_expr, file_ctx, ctx, local_context, options)?;
    match &val {
      Value::String(_) | Value::Undefined => Some(val),
      _ => {
        let (line, character) = get_location(&file_ctx.line_index, arg1_expr.span().start);
        return Err(ConfTSError::new(
          "env macro default value must be a string",
          &file_ctx.file_path,
          line,
          character,
        ));
      }
    }
  } else {
    None
  };

  if let Some(ref env) = options.env {
    if let Some(val) = env.get(&env_key) {
      return Ok(Some(Value::String(val.clone())));
    }
  }

  match std::env::var(&env_key) {
    Ok(val) => Ok(Some(Value::String(val))),
    Err(_) => match default_value {
      Some(Value::String(s)) => Ok(Some(Value::String(s))),
      _ => Ok(Some(Value::Undefined)),
    },
  }
}

fn evaluate_array_map(
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "arrayMap" || call.arguments.len() != 2 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.line_index, call.span.start);
    return Err(ConfTSError::new(
      format!(
        "Macro function '{}' must be imported from '@conf-ts/macro' to use in macro mode",
        callee
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let arr_expr = call.arguments[0].as_expression().unwrap();
  let arr = evaluate(arr_expr, file_ctx, ctx, local_context, options)?;
  let callback = call.arguments[1].as_expression().unwrap();
  let arrow = match callback {
    Expression::ArrowFunctionExpression(arrow) => arrow,
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
      return Err(ConfTSError::new(
        "arrayMap: callback must be an arrow function",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if arrow.params.items.len() != 1 {
    let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
    return Err(ConfTSError::new(
      "arrayMap: callback must have exactly one parameter",
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let param_name = extract_param_name(
    &arrow.params.items[0].pattern,
    file_ctx,
    callback,
    "arrayMap",
  )?;

  let body_expr = get_arrow_body_expr(arrow, file_ctx, "arrayMap")?;
  validate_node(body_expr, &param_name, file_ctx, ctx, "arrayMap")?;

  let items = match arr {
    Value::Array(items) => items,
    _ => return Ok(Some(Value::Array(Vec::new()))),
  };

  let mut result = Vec::new();
  for item in items {
    let mut local = HashMap::new();
    local.insert(param_name.clone(), item);
    let val = evaluate(body_expr, file_ctx, ctx, Some(&local), options)?;
    result.push(val);
  }

  Ok(Some(Value::Array(result)))
}

fn evaluate_array_flat_map(
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "arrayFlatMap" || call.arguments.len() != 2 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.line_index, call.span.start);
    return Err(ConfTSError::new(
      format!(
        "Macro function '{}' must be imported from '@conf-ts/macro' to use in macro mode",
        callee
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let arr_expr = call.arguments[0].as_expression().unwrap();
  let arr = evaluate(arr_expr, file_ctx, ctx, local_context, options)?;
  let callback = call.arguments[1].as_expression().unwrap();
  let arrow = match callback {
    Expression::ArrowFunctionExpression(arrow) => arrow,
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
      return Err(ConfTSError::new(
        "arrayFlatMap: callback must be an arrow function",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if arrow.params.items.len() != 1 {
    let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
    return Err(ConfTSError::new(
      "arrayFlatMap: callback must have exactly one parameter",
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let param_name = extract_param_name(
    &arrow.params.items[0].pattern,
    file_ctx,
    callback,
    "arrayFlatMap",
  )?;

  let body_expr = get_arrow_body_expr(arrow, file_ctx, "arrayFlatMap")?;
  validate_node(body_expr, &param_name, file_ctx, ctx, "arrayFlatMap")?;

  let items = match arr {
    Value::Array(items) => items,
    _ => return Ok(Some(Value::Array(Vec::new()))),
  };

  let mut result = Vec::new();
  for item in items {
    let mut local = HashMap::new();
    local.insert(param_name.clone(), item);
    let val = evaluate(body_expr, file_ctx, ctx, Some(&local), options)?;
    match val {
      Value::Array(items) => result.extend(items),
      value => result.push(value),
    }
  }

  Ok(Some(Value::Array(result)))
}

fn evaluate_array_filter(
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "arrayFilter" || call.arguments.len() != 2 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.line_index, call.span.start);
    return Err(ConfTSError::new(
      format!(
        "Macro function '{}' must be imported from '@conf-ts/macro' to use in macro mode",
        callee
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let arr_expr = call.arguments[0].as_expression().unwrap();
  let arr = evaluate(arr_expr, file_ctx, ctx, local_context, options)?;
  let callback = call.arguments[1].as_expression().unwrap();
  let arrow = match callback {
    Expression::ArrowFunctionExpression(arrow) => arrow,
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
      return Err(ConfTSError::new(
        "arrayFilter: callback must be an arrow function",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if arrow.params.items.len() != 1 {
    let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
    return Err(ConfTSError::new(
      "arrayFilter: callback must have exactly one parameter",
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let param_name = extract_param_name(
    &arrow.params.items[0].pattern,
    file_ctx,
    callback,
    "arrayFilter",
  )?;

  let body_expr = get_arrow_body_expr(arrow, file_ctx, "arrayFilter")?;
  validate_node(body_expr, &param_name, file_ctx, ctx, "arrayFilter")?;

  let items = match arr {
    Value::Array(items) => items,
    _ => return Ok(Some(Value::Array(Vec::new()))),
  };

  let mut result = Vec::new();
  for item in items {
    let mut local = HashMap::new();
    local.insert(param_name.clone(), item.clone());
    let val = evaluate(body_expr, file_ctx, ctx, Some(&local), options)?;
    if val.is_truthy() {
      result.push(item);
    }
  }

  Ok(Some(Value::Array(result)))
}

fn extract_param_name(
  pattern: &BindingPattern,
  file_ctx: &FileContext,
  callback: &Expression,
  macro_name: &str,
) -> Result<String, ConfTSError> {
  match pattern {
    BindingPattern::BindingIdentifier(ident) => Ok(ident.name.as_str().to_string()),
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
      Err(ConfTSError::new(
        format!("{}: callback parameter must be an identifier", macro_name),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

fn get_arrow_body_expr<'a>(
  arrow: &'a ArrowFunctionExpression<'a>,
  file_ctx: &FileContext,
  macro_name: &str,
) -> Result<&'a Expression<'a>, ConfTSError> {
  if arrow.expression {
    if let Some(Statement::ExpressionStatement(expr_stmt)) = arrow.body.statements.first() {
      return Ok(&expr_stmt.expression);
    }
    let (line, character) = get_location(&file_ctx.line_index, arrow.span.start);
    return Err(ConfTSError::new(
      format!(
        "{}: callback body must be a single expression or return statement",
        macro_name
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  if arrow.body.statements.len() != 1 {
    let (line, character) = get_location(&file_ctx.line_index, arrow.body.span.start);
    return Err(ConfTSError::new(
      format!(
        "{}: callback body must be a single return statement",
        macro_name
      ),
      &file_ctx.file_path,
      line,
      character,
    ));
  }
  match &arrow.body.statements[0] {
    Statement::ReturnStatement(ret) => match &ret.argument {
      Some(expr) => Ok(expr),
      None => {
        let (line, character) = get_location(&file_ctx.line_index, arrow.body.span.start);
        Err(ConfTSError::new(
          format!(
            "{}: callback body must be a single return statement",
            macro_name
          ),
          &file_ctx.file_path,
          line,
          character,
        ))
      }
    },
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, arrow.body.span.start);
      Err(ConfTSError::new(
        format!(
          "{}: callback body must be a single return statement",
          macro_name
        ),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

fn validate_node(
  expr: &Expression,
  param_name: &str,
  file_ctx: &FileContext,
  ctx: &EvalContext,
  macro_name: &str,
) -> Result<(), ConfTSError> {
  match expr {
    Expression::Identifier(ident) => {
      let name = ident.name.as_str();
      if name == param_name {
        return Ok(());
      }
      let (line, character) = get_location(&file_ctx.line_index, ident.span.start);
      Err(ConfTSError::new(
        format!(
          "{}: callback can only use its parameter and literals",
          macro_name
        ),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
    Expression::StringLiteral(_)
    | Expression::NumericLiteral(_)
    | Expression::BooleanLiteral(_)
    | Expression::NullLiteral(_) => Ok(()),
    Expression::StaticMemberExpression(member) => {
      if is_enum_member_access(member, ctx) {
        return Ok(());
      }
      if is_param_chain(&member.object, param_name) {
        return Ok(());
      }
      validate_node(&member.object, param_name, file_ctx, ctx, macro_name)
    }
    Expression::ComputedMemberExpression(member) => {
      if is_param_chain(&member.object, param_name) {
        return Ok(());
      }
      validate_node(&member.object, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&member.expression, param_name, file_ctx, ctx, macro_name)
    }
    Expression::ObjectExpression(obj) => {
      for prop_kind in &obj.properties {
        match prop_kind {
          ObjectPropertyKind::ObjectProperty(prop) => {
            if prop.shorthand {
              if let PropertyKey::StaticIdentifier(ident) = &prop.key {
                if ident.name.as_str() != param_name {
                  let (line, character) = get_location(&file_ctx.line_index, prop.span.start);
                  return Err(ConfTSError::new(
                    format!(
                      "{}: callback can only use its parameter and literals",
                      macro_name
                    ),
                    &file_ctx.file_path,
                    line,
                    character,
                  ));
                }
              }
            } else {
              validate_node(&prop.value, param_name, file_ctx, ctx, macro_name)?;
            }
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            validate_node(&spread.argument, param_name, file_ctx, ctx, macro_name)?;
          }
        }
      }
      Ok(())
    }
    Expression::ArrayExpression(arr) => {
      for elem in &arr.elements {
        match elem {
          ArrayExpressionElement::SpreadElement(spread) => {
            validate_node(&spread.argument, param_name, file_ctx, ctx, macro_name)?;
          }
          ArrayExpressionElement::Elision(_) => {}
          other => {
            if let Some(e) = other.as_expression() {
              validate_node(e, param_name, file_ctx, ctx, macro_name)?;
            }
          }
        }
      }
      Ok(())
    }
    Expression::BinaryExpression(bin) => {
      validate_node(&bin.left, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&bin.right, param_name, file_ctx, ctx, macro_name)
    }
    Expression::LogicalExpression(log) => {
      validate_node(&log.left, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&log.right, param_name, file_ctx, ctx, macro_name)
    }
    Expression::UnaryExpression(unary) => {
      validate_node(&unary.argument, param_name, file_ctx, ctx, macro_name)
    }
    Expression::ParenthesizedExpression(paren) => {
      validate_node(&paren.expression, param_name, file_ctx, ctx, macro_name)
    }
    Expression::ConditionalExpression(cond) => {
      validate_node(&cond.test, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&cond.consequent, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&cond.alternate, param_name, file_ctx, ctx, macro_name)
    }
    Expression::TemplateLiteral(tpl) => {
      for e in &tpl.expressions {
        validate_node(e, param_name, file_ctx, ctx, macro_name)?;
      }
      Ok(())
    }
    Expression::CallExpression(call) => {
      let callee_name = call_expr_callee_name(call);
      let macro_imports = ctx
        .macro_imports_map
        .get(&file_ctx.file_path)
        .cloned()
        .unwrap_or_default();
      if macro_imports.contains(&callee_name) {
        for arg in &call.arguments {
          if let Some(e) = arg.as_expression() {
            validate_node(e, param_name, file_ctx, ctx, macro_name)?;
          }
        }
        return Ok(());
      }
      let (line, character) = get_location(&file_ctx.line_index, call.span.start);
      Err(ConfTSError::new(
        format!(
          "{}: callback can only use its parameter and literals",
          macro_name
        ),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
    Expression::TSAsExpression(ts_as) => {
      validate_node(&ts_as.expression, param_name, file_ctx, ctx, macro_name)
    }
    Expression::TSSatisfiesExpression(ts_sat) => {
      validate_node(&ts_sat.expression, param_name, file_ctx, ctx, macro_name)
    }
    Expression::TSNonNullExpression(ts_nn) => {
      validate_node(&ts_nn.expression, param_name, file_ctx, ctx, macro_name)
    }
    _ => Ok(()),
  }
}

fn is_enum_member_access(member: &StaticMemberExpression, ctx: &EvalContext) -> bool {
  let obj_ident = match &member.object {
    Expression::Identifier(ident) => ident.name.as_str(),
    _ => return false,
  };
  let prop_name = member.property.name.as_str();
  let full_name = format!("{}.{}", obj_ident, prop_name);
  ctx
    .enum_map
    .values()
    .any(|file_enums| file_enums.contains_key(&full_name))
}

fn is_param_chain(expr: &Expression, param_name: &str) -> bool {
  match expr {
    Expression::Identifier(ident) => ident.name.as_str() == param_name,
    Expression::StaticMemberExpression(member) => is_param_chain(&member.object, param_name),
    Expression::ComputedMemberExpression(member) => is_param_chain(&member.object, param_name),
    _ => false,
  }
}
