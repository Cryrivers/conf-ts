use std::collections::HashMap;

use compiler_native::error::ConfTSError;
use compiler_native::eval::{EvalContext, evaluate, get_location};
use compiler_native::types::{CompileOptions, FileContext, QuoteStyle, Value};
use oxc_ast::ast::*;
use oxc_span::GetSpan;

/// Evaluate a macro call expression.
pub fn evaluate_macro(
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let callee = super::canonical_callee(call, file_ctx, ctx)
    .unwrap_or_else(|| compiler_native::eval::call_expr_callee_name(call));

  if let Some(val) = evaluate_expr(&callee, call, file_ctx, ctx, options)? {
    return Ok(val);
  }
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

fn check_macro_import(
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &EvalContext,
) -> bool {
  super::canonical_callee(call, file_ctx, ctx).as_deref() == Some(callee)
}

/// Extract a plain expression from a call argument, returning a compile
/// error (instead of panicking) if the argument isn't a plain expression —
/// e.g. a spread element (`fn(...[a])`), which no macro function supports.
fn expect_expression_argument<'a>(
  argument: &'a Argument<'a>,
  file_ctx: &FileContext,
  callee: &str,
) -> Result<&'a Expression<'a>, ConfTSError> {
  argument.as_expression().ok_or_else(|| {
    let (line, character) = get_location(&file_ctx.line_index, argument.span().start);
    ConfTSError::new(
      format!("{}: spread arguments are not supported", callee),
      &file_ctx.file_path,
      line,
      character,
    )
  })
}

// A call to one of the macro functions in compiler_native::eval::MACRO_FUNCTIONS is
// inlineable inside an expr() callback body — except `expr` itself, since a
// nested `expr(...)` call isn't a value expression — and only when it
// doesn't touch the context parameter, since it must be resolvable entirely
// at compile time.
fn is_inlineable_macro_call(
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &EvalContext,
) -> bool {
  super::canonical_callee(call, file_ctx, ctx).is_some_and(|name| name != "expr")
}

// Type-casting macros have a direct runtime equivalent in the expr DSL, so
// when a call to one of them can't be fully resolved to a compile-time
// constant (because it touches the context parameter), it's kept in the
// output text as a runtime call instead of failing to compile. The other
// inlineable macros (arrayMap/arrayFilter/arrayFlatMap/env) have no runtime
// equivalent, so they must always resolve to a compile-time constant or fail.
//
// This must stay in sync with its two counterparts, since nothing enforces
// agreement across the language/package boundary between them:
//   - macro-transformer/src/macro.ts: EXPR_RUNTIME_FALLBACK_MACROS
//   - expression/src/eval.ts: GLOBAL_BUILTINS (the runtime side backing
//     these names — this compiler emits e.g. `Number(x)` as literal runtime
//     call text, so @conf-ts/expression's evaluator must know how to
//     resolve `Number` as a callable, or the compiled output throws
//     "Expression value is not callable" at request time instead of
//     compile time)
const EXPR_RUNTIME_FALLBACK_MACROS: &[&str] = &["String", "Number", "Boolean"];

fn references_context_param(expr: &Expression, param_name: &str) -> bool {
  match expr {
    Expression::Identifier(ident) => ident.name.as_str() == param_name,
    Expression::BinaryExpression(bin) => {
      references_context_param(&bin.left, param_name)
        || references_context_param(&bin.right, param_name)
    }
    Expression::LogicalExpression(log) => {
      references_context_param(&log.left, param_name)
        || references_context_param(&log.right, param_name)
    }
    Expression::UnaryExpression(unary) => references_context_param(&unary.argument, param_name),
    Expression::ConditionalExpression(cond) => {
      references_context_param(&cond.test, param_name)
        || references_context_param(&cond.consequent, param_name)
        || references_context_param(&cond.alternate, param_name)
    }
    Expression::ParenthesizedExpression(paren) => {
      references_context_param(&paren.expression, param_name)
    }
    Expression::TemplateLiteral(tpl) => tpl
      .expressions
      .iter()
      .any(|e| references_context_param(e, param_name)),
    Expression::ArrayExpression(arr) => arr.elements.iter().any(|elem| match elem {
      ArrayExpressionElement::SpreadElement(spread) => {
        references_context_param(&spread.argument, param_name)
      }
      ArrayExpressionElement::Elision(_) => false,
      other => other
        .as_expression()
        .is_some_and(|e| references_context_param(e, param_name)),
    }),
    Expression::ObjectExpression(obj) => obj.properties.iter().any(|prop| match prop {
      ObjectPropertyKind::ObjectProperty(p) => {
        let key_references = p.computed
          && p
            .key
            .as_expression()
            .is_some_and(|e| references_context_param(e, param_name));
        key_references || references_context_param(&p.value, param_name)
      }
      ObjectPropertyKind::SpreadProperty(spread) => {
        references_context_param(&spread.argument, param_name)
      }
    }),
    Expression::TaggedTemplateExpression(tagged) => {
      references_context_param(&tagged.tag, param_name)
        || tagged
          .quasi
          .expressions
          .iter()
          .any(|e| references_context_param(e, param_name))
    }
    Expression::CallExpression(call) => call_references_context_param(call, param_name),
    Expression::StaticMemberExpression(member) => {
      references_context_param(&member.object, param_name)
    }
    Expression::ComputedMemberExpression(member) => {
      references_context_param(&member.object, param_name)
        || references_context_param(&member.expression, param_name)
    }
    Expression::ChainExpression(chain) => match &chain.expression {
      ChainElement::StaticMemberExpression(member) => {
        references_context_param(&member.object, param_name)
      }
      ChainElement::ComputedMemberExpression(member) => {
        references_context_param(&member.object, param_name)
          || references_context_param(&member.expression, param_name)
      }
      ChainElement::CallExpression(call) => call_references_context_param(call, param_name),
      ChainElement::TSNonNullExpression(ts_nn) => {
        references_context_param(&ts_nn.expression, param_name)
      }
      _ => false,
    },
    Expression::TSAsExpression(ts_as) => references_context_param(&ts_as.expression, param_name),
    Expression::TSSatisfiesExpression(ts_sat) => {
      references_context_param(&ts_sat.expression, param_name)
    }
    Expression::TSNonNullExpression(ts_nn) => {
      references_context_param(&ts_nn.expression, param_name)
    }
    Expression::TSTypeAssertion(assertion) => {
      references_context_param(&assertion.expression, param_name)
    }
    Expression::SequenceExpression(seq) => seq
      .expressions
      .iter()
      .any(|e| references_context_param(e, param_name)),
    _ => false,
  }
}

fn call_references_context_param(call: &CallExpression, param_name: &str) -> bool {
  references_context_param(&call.callee, param_name)
    || call.arguments.iter().any(|arg| {
      arg
        .as_expression()
        .is_some_and(|e| references_context_param(e, param_name))
    })
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

  if !check_macro_import(callee, call, file_ctx, ctx) {
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

  let arg_expr = expect_expression_argument(&call.arguments[0], file_ctx, callee)?;
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

  if !check_macro_import(callee, call, file_ctx, ctx) {
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

  let arg0_expr = expect_expression_argument(&call.arguments[0], file_ctx, callee)?;
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
    let arg1_expr = expect_expression_argument(&call.arguments[1], file_ctx, callee)?;
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

  if let Some(ref env) = options.env
    && let Some(val) = env.get(&env_key)
  {
    return Ok(Some(Value::String(val.clone())));
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

  if !check_macro_import(callee, call, file_ctx, ctx) {
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

  let arr_expr = expect_expression_argument(&call.arguments[0], file_ctx, callee)?;
  let arr = evaluate(arr_expr, file_ctx, ctx, local_context, options)?;
  let callback = expect_expression_argument(&call.arguments[1], file_ctx, callee)?;
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

  if !check_macro_import(callee, call, file_ctx, ctx) {
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

  let arr_expr = expect_expression_argument(&call.arguments[0], file_ctx, callee)?;
  let arr = evaluate(arr_expr, file_ctx, ctx, local_context, options)?;
  let callback = expect_expression_argument(&call.arguments[1], file_ctx, callee)?;
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

  if !check_macro_import(callee, call, file_ctx, ctx) {
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

  let arr_expr = expect_expression_argument(&call.arguments[0], file_ctx, callee)?;
  let arr = evaluate(arr_expr, file_ctx, ctx, local_context, options)?;
  let callback = expect_expression_argument(&call.arguments[1], file_ctx, callee)?;
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

const EXPR_CALLBACK_ERROR: &str =
  "expr callback must be an arrow function with a single identifier parameter and expression body";

type ExprReplacement = (usize, usize, String);

/// Collapse source formatting whitespace in an emitted expr while preserving
/// whitespace that belongs to string and template literal values. Template
/// interpolations are code again, so they are compacted recursively.
fn compact_expression_whitespace(source: &str) -> String {
  fn flush_space(output: &mut String, pending_space: &mut bool) {
    if *pending_space && !output.is_empty() {
      output.push(' ');
    }
    *pending_space = false;
  }

  fn copy_quoted(chars: &[char], index: &mut usize, output: &mut String, quote: char) {
    output.push(quote);
    *index += 1;

    while let Some(&ch) = chars.get(*index) {
      output.push(ch);
      *index += 1;

      if ch == '\\' {
        if let Some(&escaped) = chars.get(*index) {
          output.push(escaped);
          *index += 1;
        }
      } else if ch == quote {
        return;
      }
    }
  }

  fn copy_template(chars: &[char], index: &mut usize, output: &mut String) {
    output.push('`');
    *index += 1;

    while let Some(&ch) = chars.get(*index) {
      if ch == '\\' {
        output.push(ch);
        *index += 1;
        if let Some(&escaped) = chars.get(*index) {
          output.push(escaped);
          *index += 1;
        }
        continue;
      }

      if ch == '`' {
        output.push(ch);
        *index += 1;
        return;
      }

      if ch == '$' && chars.get(*index + 1) == Some(&'{') {
        output.push_str("${");
        *index += 2;
        compact_code(chars, index, output, true);
        continue;
      }

      output.push(ch);
      *index += 1;
    }
  }

  fn compact_code(
    chars: &[char],
    index: &mut usize,
    output: &mut String,
    stop_at_closing_brace: bool,
  ) {
    let mut pending_space = false;
    let mut brace_depth = 0usize;

    while let Some(&ch) = chars.get(*index) {
      if ch.is_whitespace() {
        pending_space = true;
        *index += 1;
        continue;
      }

      flush_space(output, &mut pending_space);

      if ch == '}' && stop_at_closing_brace && brace_depth == 0 {
        output.push(ch);
        *index += 1;
        return;
      }

      match ch {
        '\'' | '"' => copy_quoted(chars, index, output, ch),
        '`' => copy_template(chars, index, output),
        '{' => {
          output.push(ch);
          brace_depth += 1;
          *index += 1;
        }
        '}' => {
          output.push(ch);
          brace_depth = brace_depth.saturating_sub(1);
          *index += 1;
        }
        _ => {
          output.push(ch);
          *index += 1;
        }
      }
    }
  }

  let chars: Vec<char> = source.chars().collect();
  let mut index = 0;
  let mut output = String::with_capacity(source.len());
  compact_code(&chars, &mut index, &mut output, false);
  output
}

// Keep this in sync with @conf-ts/macro-transformer/src/expression-rewrite.ts encodeStringLiteral.
fn encode_string_literal(value: &str, quote: QuoteStyle) -> String {
  let json = serde_json::to_string(value).unwrap();
  match quote {
    QuoteStyle::Double => json,
    QuoteStyle::Single => {
      let inner = json[1..json.len() - 1]
        .replace("\\\"", "\"")
        .replace('\'', "\\'");
      format!("'{}'", inner)
    }
  }
}

fn value_to_expr_literal(
  value: &Value,
  file_ctx: &FileContext,
  offset: u32,
  quote: QuoteStyle,
) -> Result<String, ConfTSError> {
  match value {
    Value::Number(n) => {
      if !n.value.is_finite() {
        let (line, character) = get_location(&file_ctx.line_index, offset);
        return Err(ConfTSError::new(
          "Cannot inline non-finite number into expr",
          &file_ctx.file_path,
          line,
          character,
        ));
      }
      if n.value == 0.0 && n.value.is_sign_negative() {
        return Ok("-0".to_string());
      }
      if n.value == (n.value as i64) as f64 && n.value.abs() < 1e15 {
        Ok(format!("{}", n.value as i64))
      } else {
        Ok(format!("{}", n.value))
      }
    }
    Value::String(s) => Ok(encode_string_literal(s.as_str(), quote)),
    Value::Bool(b) => Ok(b.to_string()),
    Value::Null => Ok("null".to_string()),
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, offset);
      Err(ConfTSError::new(
        format!(
          "Cannot inline value of type {} into expr",
          value.typeof_string()
        ),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

fn get_member_root<'a>(expr: &'a Expression<'a>) -> &'a Expression<'a> {
  match expr {
    Expression::StaticMemberExpression(member) => get_member_root(&member.object),
    Expression::ComputedMemberExpression(member) => get_member_root(&member.object),
    Expression::TSAsExpression(ts_as) => get_member_root(&ts_as.expression),
    Expression::TSSatisfiesExpression(ts_satisfies) => get_member_root(&ts_satisfies.expression),
    Expression::TSNonNullExpression(ts_non_null) => get_member_root(&ts_non_null.expression),
    Expression::TSTypeAssertion(assertion) => get_member_root(&assertion.expression),
    _ => expr,
  }
}

fn collect_const_replacements(
  expr: &Expression,
  param_name: &str,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<(), ConfTSError> {
  match expr {
    Expression::StaticMemberExpression(member) => {
      let root = get_member_root(&member.object);
      if matches!(root, Expression::Identifier(id) if id.name.as_str() == param_name) {
        return collect_const_replacements(
          &member.object,
          param_name,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        );
      }
      let value = evaluate(expr, file_ctx, ctx, None, options)?;
      let literal = value_to_expr_literal(&value, file_ctx, expr.span().start, options.quote)?;
      let start = expr.span().start as usize - body_start as usize;
      let end = expr.span().end as usize - body_start as usize;
      replacements.push((start, end, literal));
      Ok(())
    }

    // ctx[key] where key is a const identifier — resolve key and replace entire expression
    Expression::ComputedMemberExpression(member)
      if matches!(&member.object, Expression::Identifier(id) if id.name.as_str() == param_name)
        && !matches!(&member.expression, Expression::StringLiteral(_)) =>
    {
      let key_value = evaluate(&member.expression, file_ctx, ctx, None, options)?;
      match &key_value {
        Value::String(s) if is_valid_identifier(s) => {
          let start = expr.span().start as usize - body_start as usize;
          let end = expr.span().end as usize - body_start as usize;
          replacements.push((start, end, s.clone()));
          Ok(())
        }
        _ => {
          let (line, character) =
            get_location(&file_ctx.line_index, member.expression.span().start);
          Err(ConfTSError::new(
            "expr callback can only access context properties with identifier property names",
            &file_ctx.file_path,
            line,
            character,
          ))
        }
      }
    }

    Expression::Identifier(ident) if ident.name.as_str() != param_name => {
      let value = evaluate(expr, file_ctx, ctx, None, options)?;
      let literal = value_to_expr_literal(&value, file_ctx, expr.span().start, options.quote)?;
      let start = expr.span().start as usize - body_start as usize;
      let end = expr.span().end as usize - body_start as usize;
      replacements.push((start, end, literal));
      Ok(())
    }

    Expression::CallExpression(call) => {
      if is_inlineable_macro_call(call, file_ctx, ctx) {
        let callee_name = super::canonical_callee(call, file_ctx, ctx)
          .unwrap_or_else(|| compiler_native::eval::call_expr_callee_name(call));
        // Only take the runtime-fallback path for a single, plain-expression
        // argument: this must match the arity/shape evaluate_type_casting
        // requires, so a malformed call (wrong arg count, or a spread
        // argument the expr DSL doesn't support) falls through to the eager
        // path below and gets a proper compile error there instead of
        // silently compiling or being mishandled here.
        if EXPR_RUNTIME_FALLBACK_MACROS.contains(&callee_name.as_str())
          && call.arguments.len() == 1
          && call.arguments[0].as_expression().is_some()
          && references_context_param(expr, param_name)
        {
          for arg in &call.arguments {
            if let Some(e) = arg.as_expression() {
              collect_const_replacements(
                e,
                param_name,
                body_start,
                replacements,
                file_ctx,
                ctx,
                options,
              )?;
            }
          }
          return Ok(());
        }
        let value = evaluate(expr, file_ctx, ctx, None, options)?;
        let literal = value_to_expr_literal(&value, file_ctx, expr.span().start, options.quote)?;
        let start = expr.span().start as usize - body_start as usize;
        let end = expr.span().end as usize - body_start as usize;
        replacements.push((start, end, literal));
        return Ok(());
      }
      walk_const_children(
        expr,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }

    _ => walk_const_children(
      expr,
      param_name,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
  }
}

fn walk_const_children(
  expr: &Expression,
  param_name: &str,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<(), ConfTSError> {
  match expr {
    Expression::BinaryExpression(bin) => {
      collect_const_replacements(
        &bin.left,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &bin.right,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }
    Expression::LogicalExpression(log) => {
      collect_const_replacements(
        &log.left,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &log.right,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }
    Expression::UnaryExpression(unary) => collect_const_replacements(
      &unary.argument,
      param_name,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::ConditionalExpression(cond) => {
      collect_const_replacements(
        &cond.test,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &cond.consequent,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &cond.alternate,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }
    Expression::ParenthesizedExpression(paren) => collect_const_replacements(
      &paren.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TemplateLiteral(tpl) => {
      for e in &tpl.expressions {
        collect_const_replacements(
          e,
          param_name,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
      }
      Ok(())
    }
    Expression::ArrayExpression(arr) => {
      for elem in &arr.elements {
        match elem {
          ArrayExpressionElement::SpreadElement(spread) => {
            collect_const_replacements(
              &spread.argument,
              param_name,
              body_start,
              replacements,
              file_ctx,
              ctx,
              options,
            )?;
          }
          ArrayExpressionElement::Elision(_) => {}
          other => {
            if let Some(e) = other.as_expression() {
              collect_const_replacements(
                e,
                param_name,
                body_start,
                replacements,
                file_ctx,
                ctx,
                options,
              )?;
            }
          }
        }
      }
      Ok(())
    }
    Expression::ObjectExpression(obj) => {
      for prop_kind in &obj.properties {
        match prop_kind {
          ObjectPropertyKind::ObjectProperty(prop) => {
            if !prop.shorthand {
              collect_const_replacements(
                &prop.value,
                param_name,
                body_start,
                replacements,
                file_ctx,
                ctx,
                options,
              )?;
            }
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            collect_const_replacements(
              &spread.argument,
              param_name,
              body_start,
              replacements,
              file_ctx,
              ctx,
              options,
            )?;
          }
        }
      }
      Ok(())
    }
    Expression::CallExpression(call) => {
      collect_const_replacements(
        &call.callee,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      for arg in &call.arguments {
        if let Some(e) = arg.as_expression() {
          collect_const_replacements(
            e,
            param_name,
            body_start,
            replacements,
            file_ctx,
            ctx,
            options,
          )?;
        }
      }
      Ok(())
    }
    Expression::ComputedMemberExpression(member) => {
      collect_const_replacements(
        &member.object,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &member.expression,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }
    Expression::ChainExpression(chain) => match &chain.expression {
      ChainElement::StaticMemberExpression(member) => collect_const_replacements(
        &member.object,
        param_name,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      ),
      ChainElement::ComputedMemberExpression(member) => {
        collect_const_replacements(
          &member.object,
          param_name,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
        collect_const_replacements(
          &member.expression,
          param_name,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )
      }
      ChainElement::CallExpression(call) => {
        collect_const_replacements(
          &call.callee,
          param_name,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
        for arg in &call.arguments {
          if let Some(expression) = arg.as_expression() {
            collect_const_replacements(
              expression,
              param_name,
              body_start,
              replacements,
              file_ctx,
              ctx,
              options,
            )?;
          }
        }
        Ok(())
      }
      _ => Ok(()),
    },
    Expression::TSAsExpression(ts_as) => collect_const_replacements(
      &ts_as.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSSatisfiesExpression(ts_sat) => collect_const_replacements(
      &ts_sat.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSNonNullExpression(ts_nn) => collect_const_replacements(
      &ts_nn.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSTypeAssertion(assertion) => collect_const_replacements(
      &assertion.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::SequenceExpression(seq) => {
      for e in &seq.expressions {
        collect_const_replacements(
          e,
          param_name,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
      }
      Ok(())
    }
    _ => Ok(()),
  }
}

fn collect_type_syntax_erasures(
  expr: &Expression,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
) {
  match expr {
    Expression::TSAsExpression(ts_as) => {
      replacements.push((
        ts_as.expression.span().end as usize - body_start as usize,
        ts_as.span.end as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&ts_as.expression, body_start, replacements);
    }
    Expression::TSSatisfiesExpression(ts_satisfies) => {
      replacements.push((
        ts_satisfies.expression.span().end as usize - body_start as usize,
        ts_satisfies.span.end as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&ts_satisfies.expression, body_start, replacements);
    }
    Expression::TSNonNullExpression(ts_non_null) => {
      replacements.push((
        ts_non_null.expression.span().end as usize - body_start as usize,
        ts_non_null.span.end as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&ts_non_null.expression, body_start, replacements);
    }
    Expression::TSTypeAssertion(assertion) => {
      replacements.push((
        assertion.span.start as usize - body_start as usize,
        assertion.expression.span().start as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&assertion.expression, body_start, replacements);
    }
    Expression::BinaryExpression(binary) => {
      collect_type_syntax_erasures(&binary.left, body_start, replacements);
      collect_type_syntax_erasures(&binary.right, body_start, replacements);
    }
    Expression::LogicalExpression(logical) => {
      collect_type_syntax_erasures(&logical.left, body_start, replacements);
      collect_type_syntax_erasures(&logical.right, body_start, replacements);
    }
    Expression::UnaryExpression(unary) => {
      collect_type_syntax_erasures(&unary.argument, body_start, replacements);
    }
    Expression::ConditionalExpression(conditional) => {
      collect_type_syntax_erasures(&conditional.test, body_start, replacements);
      collect_type_syntax_erasures(&conditional.consequent, body_start, replacements);
      collect_type_syntax_erasures(&conditional.alternate, body_start, replacements);
    }
    Expression::ParenthesizedExpression(parenthesized) => {
      collect_type_syntax_erasures(&parenthesized.expression, body_start, replacements);
    }
    Expression::StaticMemberExpression(member) => {
      collect_type_syntax_erasures(&member.object, body_start, replacements);
    }
    Expression::ComputedMemberExpression(member) => {
      collect_type_syntax_erasures(&member.object, body_start, replacements);
      collect_type_syntax_erasures(&member.expression, body_start, replacements);
    }
    Expression::CallExpression(call) => {
      collect_type_syntax_erasures(&call.callee, body_start, replacements);
      for argument in &call.arguments {
        if let Some(expression) = argument.as_expression() {
          collect_type_syntax_erasures(expression, body_start, replacements);
        }
      }
    }
    Expression::ChainExpression(chain) => match &chain.expression {
      ChainElement::StaticMemberExpression(member) => {
        collect_type_syntax_erasures(&member.object, body_start, replacements);
      }
      ChainElement::ComputedMemberExpression(member) => {
        collect_type_syntax_erasures(&member.object, body_start, replacements);
        collect_type_syntax_erasures(&member.expression, body_start, replacements);
      }
      ChainElement::CallExpression(call) => {
        collect_type_syntax_erasures(&call.callee, body_start, replacements);
        for argument in &call.arguments {
          if let Some(expression) = argument.as_expression() {
            collect_type_syntax_erasures(expression, body_start, replacements);
          }
        }
      }
      _ => {}
    },
    Expression::ArrayExpression(array) => {
      for element in &array.elements {
        if let Some(expression) = element.as_expression() {
          collect_type_syntax_erasures(expression, body_start, replacements);
        }
      }
    }
    Expression::ObjectExpression(object) => {
      for property in &object.properties {
        match property {
          ObjectPropertyKind::ObjectProperty(property) => {
            collect_type_syntax_erasures(&property.value, body_start, replacements);
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            collect_type_syntax_erasures(&spread.argument, body_start, replacements);
          }
        }
      }
    }
    Expression::TemplateLiteral(template) => {
      for expression in &template.expressions {
        collect_type_syntax_erasures(expression, body_start, replacements);
      }
    }
    Expression::SequenceExpression(sequence) => {
      for expression in &sequence.expressions {
        collect_type_syntax_erasures(expression, body_start, replacements);
      }
    }
    _ => {}
  }
}

fn is_span_covered_by_prior(start: usize, end: usize, prior: &[ExprReplacement]) -> bool {
  prior
    .iter()
    .any(|(prior_start, prior_end, _)| *prior_start <= start && end <= *prior_end)
}

fn collect_string_literal_requote(
  string: &StringLiteral<'_>,
  body_start: u32,
  prior: &[ExprReplacement],
  out: &mut Vec<ExprReplacement>,
  quote: QuoteStyle,
) {
  let start = string.span.start as usize - body_start as usize;
  let end = string.span.end as usize - body_start as usize;
  if is_span_covered_by_prior(start, end, prior) {
    return;
  }
  out.push((
    start,
    end,
    encode_string_literal(string.value.as_str(), quote),
  ));
}

fn collect_property_key_requotes(
  key: &PropertyKey<'_>,
  body_start: u32,
  prior: &[ExprReplacement],
  out: &mut Vec<ExprReplacement>,
  quote: QuoteStyle,
) {
  match key {
    PropertyKey::StringLiteral(string) => {
      collect_string_literal_requote(string, body_start, prior, out, quote);
    }
    _ => {
      if let Some(expr) = key.as_expression() {
        collect_string_requotes(expr, body_start, prior, out, quote);
      }
    }
  }
}

fn collect_argument_requotes(
  argument: &Argument<'_>,
  body_start: u32,
  prior: &[ExprReplacement],
  out: &mut Vec<ExprReplacement>,
  quote: QuoteStyle,
) {
  match argument {
    Argument::SpreadElement(spread) => {
      collect_string_requotes(&spread.argument, body_start, prior, out, quote);
    }
    _ => {
      if let Some(expr) = argument.as_expression() {
        collect_string_requotes(expr, body_start, prior, out, quote);
      }
    }
  }
}

fn collect_chain_element_requotes(
  chain: &ChainElement<'_>,
  body_start: u32,
  prior: &[ExprReplacement],
  out: &mut Vec<ExprReplacement>,
  quote: QuoteStyle,
) {
  match chain {
    ChainElement::StaticMemberExpression(member) => {
      collect_string_requotes(&member.object, body_start, prior, out, quote);
    }
    ChainElement::ComputedMemberExpression(member) => {
      collect_string_requotes(&member.object, body_start, prior, out, quote);
      collect_string_requotes(&member.expression, body_start, prior, out, quote);
    }
    ChainElement::CallExpression(call) => {
      collect_string_requotes(&call.callee, body_start, prior, out, quote);
      for argument in &call.arguments {
        collect_argument_requotes(argument, body_start, prior, out, quote);
      }
    }
    ChainElement::TSNonNullExpression(ts_nn) => {
      collect_string_requotes(&ts_nn.expression, body_start, prior, out, quote);
    }
    _ => {}
  }
}

fn collect_string_requotes(
  expr: &Expression,
  body_start: u32,
  prior: &[ExprReplacement],
  out: &mut Vec<ExprReplacement>,
  quote: QuoteStyle,
) {
  match expr {
    Expression::StringLiteral(string) => {
      collect_string_literal_requote(string, body_start, prior, out, quote);
    }
    Expression::TSAsExpression(ts_as) => {
      collect_string_requotes(&ts_as.expression, body_start, prior, out, quote);
    }
    Expression::TSSatisfiesExpression(ts_satisfies) => {
      collect_string_requotes(&ts_satisfies.expression, body_start, prior, out, quote);
    }
    Expression::TSNonNullExpression(ts_non_null) => {
      collect_string_requotes(&ts_non_null.expression, body_start, prior, out, quote);
    }
    Expression::TSTypeAssertion(assertion) => {
      collect_string_requotes(&assertion.expression, body_start, prior, out, quote);
    }
    Expression::BinaryExpression(binary) => {
      collect_string_requotes(&binary.left, body_start, prior, out, quote);
      collect_string_requotes(&binary.right, body_start, prior, out, quote);
    }
    Expression::LogicalExpression(logical) => {
      collect_string_requotes(&logical.left, body_start, prior, out, quote);
      collect_string_requotes(&logical.right, body_start, prior, out, quote);
    }
    Expression::UnaryExpression(unary) => {
      collect_string_requotes(&unary.argument, body_start, prior, out, quote);
    }
    Expression::ConditionalExpression(conditional) => {
      collect_string_requotes(&conditional.test, body_start, prior, out, quote);
      collect_string_requotes(&conditional.consequent, body_start, prior, out, quote);
      collect_string_requotes(&conditional.alternate, body_start, prior, out, quote);
    }
    Expression::ParenthesizedExpression(parenthesized) => {
      collect_string_requotes(&parenthesized.expression, body_start, prior, out, quote);
    }
    Expression::StaticMemberExpression(member) => {
      collect_string_requotes(&member.object, body_start, prior, out, quote);
    }
    Expression::ComputedMemberExpression(member) => {
      collect_string_requotes(&member.object, body_start, prior, out, quote);
      collect_string_requotes(&member.expression, body_start, prior, out, quote);
    }
    Expression::CallExpression(call) => {
      collect_string_requotes(&call.callee, body_start, prior, out, quote);
      for argument in &call.arguments {
        collect_argument_requotes(argument, body_start, prior, out, quote);
      }
    }
    Expression::ChainExpression(chain) => {
      collect_chain_element_requotes(&chain.expression, body_start, prior, out, quote);
    }
    Expression::ArrayExpression(array) => {
      for element in &array.elements {
        match element {
          ArrayExpressionElement::SpreadElement(spread) => {
            collect_string_requotes(&spread.argument, body_start, prior, out, quote);
          }
          ArrayExpressionElement::Elision(_) => {}
          other => {
            if let Some(expression) = other.as_expression() {
              collect_string_requotes(expression, body_start, prior, out, quote);
            }
          }
        }
      }
    }
    Expression::ObjectExpression(object) => {
      for property in &object.properties {
        match property {
          ObjectPropertyKind::ObjectProperty(property) => {
            collect_property_key_requotes(&property.key, body_start, prior, out, quote);
            collect_string_requotes(&property.value, body_start, prior, out, quote);
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            collect_string_requotes(&spread.argument, body_start, prior, out, quote);
          }
        }
      }
    }
    Expression::TemplateLiteral(template) => {
      for expression in &template.expressions {
        collect_string_requotes(expression, body_start, prior, out, quote);
      }
    }
    Expression::SequenceExpression(sequence) => {
      for expression in &sequence.expressions {
        collect_string_requotes(expression, body_start, prior, out, quote);
      }
    }
    _ => {}
  }
}

fn evaluate_expr(
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "expr" {
    return Ok(None);
  }

  if !check_macro_import(callee, call, file_ctx, ctx) {
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

  if call.arguments.len() != 1 {
    let (line, character) = get_location(&file_ctx.line_index, call.span.start);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let callback = expect_expression_argument(&call.arguments[0], file_ctx, callee)?;
  let arrow = match callback {
    Expression::ArrowFunctionExpression(arrow) if !arrow.r#async => arrow,
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
      return Err(ConfTSError::new(
        EXPR_CALLBACK_ERROR,
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if arrow.params.items.len() != 1 || arrow.params.rest.is_some() {
    let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let param_name = match &arrow.params.items[0].pattern {
    BindingPattern::BindingIdentifier(ident) => ident.name.as_str().to_string(),
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, arrow.params.span.start);
      return Err(ConfTSError::new(
        EXPR_CALLBACK_ERROR,
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if !arrow.expression {
    let (line, character) = get_location(&file_ctx.line_index, arrow.body.span.start);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let body_expr = match arrow.body.statements.first() {
    Some(Statement::ExpressionStatement(expr_stmt)) => &expr_stmt.expression,
    _ => {
      let (line, character) = get_location(&file_ctx.line_index, arrow.body.span.start);
      return Err(ConfTSError::new(
        EXPR_CALLBACK_ERROR,
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  validate_expr_syntax(body_expr, file_ctx)?;

  let source = file_ctx.parsed.source();
  let body_start = body_expr.span().start;
  let body_text = &source[body_start as usize..body_expr.span().end as usize];

  let mut replacements: Vec<ExprReplacement> = Vec::new();
  collect_const_replacements(
    body_expr,
    &param_name,
    body_start,
    &mut replacements,
    file_ctx,
    ctx,
    options,
  )?;
  collect_context_replacements(
    body_expr,
    &param_name,
    body_start,
    &mut replacements,
    file_ctx,
  )?;
  collect_type_syntax_erasures(body_expr, body_start, &mut replacements);
  let prior_replacements = replacements.clone();
  collect_string_requotes(
    body_expr,
    body_start,
    &prior_replacements,
    &mut replacements,
    options.quote,
  );

  replacements.sort_by_key(|replacement| std::cmp::Reverse(replacement.0));
  let mut result = body_text.to_string();
  for (start, end, replacement) in &replacements {
    result.replace_range(*start..*end, replacement);
  }

  Ok(Some(Value::String(compact_expression_whitespace(&result))))
}

fn is_valid_identifier(s: &str) -> bool {
  let mut chars = s.chars();
  match chars.next() {
    None => false,
    Some(c) if c == '_' || c == '$' || c.is_ascii_alphabetic() => {
      chars.all(|c| c == '_' || c == '$' || c.is_ascii_alphanumeric())
    }
    _ => false,
  }
}

fn replace_static_context_root(
  member: &StaticMemberExpression<'_>,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
) {
  let relative_start = member.object.span().start as usize - body_start as usize;
  let relative_end = member.property.span.start as usize - body_start as usize;
  replacements.push((relative_start, relative_end, String::new()));
}

fn replace_computed_context_root(
  member: &ComputedMemberExpression<'_>,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
) -> Result<(), ConfTSError> {
  let relative_start = member.span.start as usize - body_start as usize;
  let relative_end = member.span.end as usize - body_start as usize;
  if replacements
    .iter()
    .any(|(start, end, _)| *start == relative_start && *end == relative_end)
  {
    return Ok(());
  }

  if let Expression::StringLiteral(string) = &member.expression {
    let key = string.value.as_str();
    if is_valid_identifier(key) {
      replacements.push((relative_start, relative_end, key.to_string()));
      return Ok(());
    }
  }

  let (line, character) = get_location(&file_ctx.line_index, member.span.start);
  Err(ConfTSError::new(
    "expr callback can only access context properties with identifier property names",
    &file_ctx.file_path,
    line,
    character,
  ))
}

fn collect_context_replacements(
  expr: &Expression,
  param_name: &str,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
) -> Result<(), ConfTSError> {
  match expr {
    Expression::StaticMemberExpression(member) if matches!(&member.object, Expression::Identifier(id) if id.name.as_str() == param_name) =>
    {
      replace_static_context_root(member, body_start, replacements);
      Ok(())
    }

    Expression::ComputedMemberExpression(member) if matches!(&member.object, Expression::Identifier(id) if id.name.as_str() == param_name) => {
      replace_computed_context_root(member, body_start, replacements, file_ctx)
    }

    Expression::Identifier(ident) if ident.name.as_str() == param_name => {
      let (line, character) = get_location(&file_ctx.line_index, ident.span.start);
      Err(ConfTSError::new(
        "expr callback cannot use the context parameter directly",
        &file_ctx.file_path,
        line,
        character,
      ))
    }

    _ => walk_expr_children(expr, param_name, body_start, replacements, file_ctx),
  }
}

fn walk_expr_children(
  expr: &Expression,
  param_name: &str,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
) -> Result<(), ConfTSError> {
  match expr {
    Expression::BinaryExpression(bin) => {
      collect_context_replacements(&bin.left, param_name, body_start, replacements, file_ctx)?;
      collect_context_replacements(&bin.right, param_name, body_start, replacements, file_ctx)
    }
    Expression::LogicalExpression(log) => {
      collect_context_replacements(&log.left, param_name, body_start, replacements, file_ctx)?;
      collect_context_replacements(&log.right, param_name, body_start, replacements, file_ctx)
    }
    Expression::UnaryExpression(unary) => collect_context_replacements(
      &unary.argument,
      param_name,
      body_start,
      replacements,
      file_ctx,
    ),
    Expression::ConditionalExpression(cond) => {
      collect_context_replacements(&cond.test, param_name, body_start, replacements, file_ctx)?;
      collect_context_replacements(
        &cond.consequent,
        param_name,
        body_start,
        replacements,
        file_ctx,
      )?;
      collect_context_replacements(
        &cond.alternate,
        param_name,
        body_start,
        replacements,
        file_ctx,
      )
    }
    Expression::ParenthesizedExpression(paren) => collect_context_replacements(
      &paren.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
    ),
    Expression::TemplateLiteral(tpl) => {
      for e in &tpl.expressions {
        collect_context_replacements(e, param_name, body_start, replacements, file_ctx)?;
      }
      Ok(())
    }
    Expression::ArrayExpression(arr) => {
      for elem in &arr.elements {
        match elem {
          ArrayExpressionElement::SpreadElement(spread) => {
            collect_context_replacements(
              &spread.argument,
              param_name,
              body_start,
              replacements,
              file_ctx,
            )?;
          }
          ArrayExpressionElement::Elision(_) => {}
          other => {
            if let Some(e) = other.as_expression() {
              collect_context_replacements(e, param_name, body_start, replacements, file_ctx)?;
            }
          }
        }
      }
      Ok(())
    }
    Expression::ObjectExpression(obj) => {
      for prop_kind in &obj.properties {
        match prop_kind {
          ObjectPropertyKind::ObjectProperty(prop) => {
            if !prop.shorthand {
              collect_context_replacements(
                &prop.value,
                param_name,
                body_start,
                replacements,
                file_ctx,
              )?;
            }
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            collect_context_replacements(
              &spread.argument,
              param_name,
              body_start,
              replacements,
              file_ctx,
            )?;
          }
        }
      }
      Ok(())
    }
    Expression::CallExpression(call) => {
      collect_context_replacements(&call.callee, param_name, body_start, replacements, file_ctx)?;
      for arg in &call.arguments {
        if let Some(e) = arg.as_expression() {
          collect_context_replacements(e, param_name, body_start, replacements, file_ctx)?;
        }
      }
      Ok(())
    }
    Expression::StaticMemberExpression(member) => collect_context_replacements(
      &member.object,
      param_name,
      body_start,
      replacements,
      file_ctx,
    ),
    Expression::ComputedMemberExpression(member) => {
      collect_context_replacements(
        &member.object,
        param_name,
        body_start,
        replacements,
        file_ctx,
      )?;
      collect_context_replacements(
        &member.expression,
        param_name,
        body_start,
        replacements,
        file_ctx,
      )
    }
    Expression::ChainExpression(chain) => match &chain.expression {
      ChainElement::StaticMemberExpression(member) if matches!(&member.object, Expression::Identifier(id) if id.name.as_str() == param_name) =>
      {
        replace_static_context_root(member, body_start, replacements);
        Ok(())
      }
      ChainElement::ComputedMemberExpression(member) if matches!(&member.object, Expression::Identifier(id) if id.name.as_str() == param_name) => {
        replace_computed_context_root(member, body_start, replacements, file_ctx)
      }
      ChainElement::StaticMemberExpression(member) => collect_context_replacements(
        &member.object,
        param_name,
        body_start,
        replacements,
        file_ctx,
      ),
      ChainElement::ComputedMemberExpression(member) => {
        collect_context_replacements(
          &member.object,
          param_name,
          body_start,
          replacements,
          file_ctx,
        )?;
        collect_context_replacements(
          &member.expression,
          param_name,
          body_start,
          replacements,
          file_ctx,
        )
      }
      ChainElement::CallExpression(call) => {
        collect_context_replacements(&call.callee, param_name, body_start, replacements, file_ctx)?;
        for arg in &call.arguments {
          if let Some(expression) = arg.as_expression() {
            collect_context_replacements(
              expression,
              param_name,
              body_start,
              replacements,
              file_ctx,
            )?;
          }
        }
        Ok(())
      }
      _ => Ok(()),
    },
    Expression::TSAsExpression(ts_as) => collect_context_replacements(
      &ts_as.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
    ),
    Expression::TSSatisfiesExpression(ts_sat) => collect_context_replacements(
      &ts_sat.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
    ),
    Expression::TSNonNullExpression(ts_nn) => collect_context_replacements(
      &ts_nn.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
    ),
    Expression::TSTypeAssertion(assertion) => collect_context_replacements(
      &assertion.expression,
      param_name,
      body_start,
      replacements,
      file_ctx,
    ),
    Expression::SequenceExpression(seq) => {
      for e in &seq.expressions {
        collect_context_replacements(e, param_name, body_start, replacements, file_ctx)?;
      }
      Ok(())
    }
    _ => Ok(()),
  }
}

fn validate_expr_syntax(expr: &Expression, file_ctx: &FileContext) -> Result<(), ConfTSError> {
  match expr {
    Expression::AssignmentExpression(assignment) => {
      let source = file_ctx.parsed.source();
      let text = &source[assignment.span.start as usize..assignment.span.end as usize];
      let (line, character) = get_location(&file_ctx.line_index, assignment.span.start);
      Err(ConfTSError::new(
        format!("parse expression error: {}", text),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
    Expression::BinaryExpression(bin) => {
      validate_expr_syntax(&bin.left, file_ctx)?;
      validate_expr_syntax(&bin.right, file_ctx)
    }
    Expression::UnaryExpression(unary) => validate_expr_syntax(&unary.argument, file_ctx),
    Expression::LogicalExpression(log) => {
      validate_expr_syntax(&log.left, file_ctx)?;
      validate_expr_syntax(&log.right, file_ctx)
    }
    Expression::ConditionalExpression(cond) => {
      validate_expr_syntax(&cond.test, file_ctx)?;
      validate_expr_syntax(&cond.consequent, file_ctx)?;
      validate_expr_syntax(&cond.alternate, file_ctx)
    }
    Expression::ParenthesizedExpression(paren) => validate_expr_syntax(&paren.expression, file_ctx),
    Expression::StaticMemberExpression(member) => validate_expr_syntax(&member.object, file_ctx),
    Expression::ComputedMemberExpression(member) => {
      validate_expr_syntax(&member.object, file_ctx)?;
      validate_expr_syntax(&member.expression, file_ctx)
    }
    Expression::CallExpression(call) => {
      validate_expr_syntax(&call.callee, file_ctx)?;
      for arg in &call.arguments {
        if let Some(e) = arg.as_expression() {
          validate_expr_syntax(e, file_ctx)?;
        }
      }
      Ok(())
    }
    Expression::ArrayExpression(arr) => {
      for elem in &arr.elements {
        if let Some(e) = elem.as_expression() {
          validate_expr_syntax(e, file_ctx)?;
        }
      }
      Ok(())
    }
    Expression::ObjectExpression(obj) => {
      for prop_kind in &obj.properties {
        match prop_kind {
          ObjectPropertyKind::ObjectProperty(prop) => {
            validate_expr_syntax(&prop.value, file_ctx)?;
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            validate_expr_syntax(&spread.argument, file_ctx)?;
          }
        }
      }
      Ok(())
    }
    Expression::TemplateLiteral(tpl) => {
      for e in &tpl.expressions {
        validate_expr_syntax(e, file_ctx)?;
      }
      Ok(())
    }
    Expression::TSAsExpression(ts_as) => validate_expr_syntax(&ts_as.expression, file_ctx),
    Expression::TSSatisfiesExpression(ts_sat) => validate_expr_syntax(&ts_sat.expression, file_ctx),
    Expression::TSNonNullExpression(ts_nn) => validate_expr_syntax(&ts_nn.expression, file_ctx),
    Expression::TSTypeAssertion(assertion) => validate_expr_syntax(&assertion.expression, file_ctx),
    Expression::SequenceExpression(seq) => {
      for e in &seq.expressions {
        validate_expr_syntax(e, file_ctx)?;
      }
      Ok(())
    }
    _ => Ok(()),
  }
}
