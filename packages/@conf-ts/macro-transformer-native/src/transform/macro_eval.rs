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
  match evaluate_expr_template_invocation(call, file_ctx, ctx, local_context, options) {
    Ok(Some(value)) => return Ok(value),
    Ok(None) => {}
    Err(error) => {
      super::record_fatal_transform_error(ctx, error.clone());
      return Err(error);
    }
  }

  let callee = super::canonical_callee(call, file_ctx, ctx)
    .unwrap_or_else(|| compiler_native::eval::call_expr_callee_name(call));

  if let Some(val) = evaluate_expr(&callee, call, file_ctx, ctx, options)? {
    return Ok(val);
  }
  if let Some(val) = evaluate_type_casting(&callee, call, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }
  if let Some(val) = evaluate_array_macro(
    ArrayMacroMethod::Map,
    &callee,
    call,
    file_ctx,
    ctx,
    local_context,
    options,
  )? {
    return Ok(val);
  }
  if let Some(val) = evaluate_array_macro(
    ArrayMacroMethod::FlatMap,
    &callee,
    call,
    file_ctx,
    ctx,
    local_context,
    options,
  )? {
    return Ok(val);
  }
  if let Some(val) = evaluate_array_macro(
    ArrayMacroMethod::Filter,
    &callee,
    call,
    file_ctx,
    ctx,
    local_context,
    options,
  )? {
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

// Whether folding `expr` to a compile-time literal is even possible: it must
// not touch the context param (a runtime-only value) nor any name bound by
// an enclosing nested callback (e.g. the `row` in
// `ctx.matrix.map(row => row.filter(x => x > 0).length)`, which is just as
// unresolvable at compile time as the context itself).
fn references_unfoldable_name(expr: &Expression, param_name: &str, bound_names: &[String]) -> bool {
  match expr {
    Expression::Identifier(ident) => {
      ident.name.as_str() == param_name
        || bound_names.iter().any(|name| name == ident.name.as_str())
    }
    Expression::BinaryExpression(bin) => {
      references_unfoldable_name(&bin.left, param_name, bound_names)
        || references_unfoldable_name(&bin.right, param_name, bound_names)
    }
    Expression::LogicalExpression(log) => {
      references_unfoldable_name(&log.left, param_name, bound_names)
        || references_unfoldable_name(&log.right, param_name, bound_names)
    }
    Expression::UnaryExpression(unary) => {
      references_unfoldable_name(&unary.argument, param_name, bound_names)
    }
    Expression::ConditionalExpression(cond) => {
      references_unfoldable_name(&cond.test, param_name, bound_names)
        || references_unfoldable_name(&cond.consequent, param_name, bound_names)
        || references_unfoldable_name(&cond.alternate, param_name, bound_names)
    }
    Expression::ParenthesizedExpression(paren) => {
      references_unfoldable_name(&paren.expression, param_name, bound_names)
    }
    Expression::TemplateLiteral(tpl) => tpl
      .expressions
      .iter()
      .any(|e| references_unfoldable_name(e, param_name, bound_names)),
    Expression::ArrayExpression(arr) => arr.elements.iter().any(|elem| match elem {
      ArrayExpressionElement::SpreadElement(spread) => {
        references_unfoldable_name(&spread.argument, param_name, bound_names)
      }
      ArrayExpressionElement::Elision(_) => false,
      other => other
        .as_expression()
        .is_some_and(|e| references_unfoldable_name(e, param_name, bound_names)),
    }),
    Expression::ObjectExpression(obj) => obj.properties.iter().any(|prop| match prop {
      ObjectPropertyKind::ObjectProperty(p) => {
        let key_references = p.computed
          && p
            .key
            .as_expression()
            .is_some_and(|e| references_unfoldable_name(e, param_name, bound_names));
        key_references || references_unfoldable_name(&p.value, param_name, bound_names)
      }
      ObjectPropertyKind::SpreadProperty(spread) => {
        references_unfoldable_name(&spread.argument, param_name, bound_names)
      }
    }),
    Expression::TaggedTemplateExpression(tagged) => {
      references_unfoldable_name(&tagged.tag, param_name, bound_names)
        || tagged
          .quasi
          .expressions
          .iter()
          .any(|e| references_unfoldable_name(e, param_name, bound_names))
    }
    Expression::CallExpression(call) => {
      call_references_unfoldable_name(call, param_name, bound_names)
    }
    Expression::StaticMemberExpression(member) => {
      references_unfoldable_name(&member.object, param_name, bound_names)
    }
    Expression::ComputedMemberExpression(member) => {
      references_unfoldable_name(&member.object, param_name, bound_names)
        || references_unfoldable_name(&member.expression, param_name, bound_names)
    }
    Expression::ChainExpression(chain) => match &chain.expression {
      ChainElement::StaticMemberExpression(member) => {
        references_unfoldable_name(&member.object, param_name, bound_names)
      }
      ChainElement::ComputedMemberExpression(member) => {
        references_unfoldable_name(&member.object, param_name, bound_names)
          || references_unfoldable_name(&member.expression, param_name, bound_names)
      }
      ChainElement::CallExpression(call) => {
        call_references_unfoldable_name(call, param_name, bound_names)
      }
      ChainElement::TSNonNullExpression(ts_nn) => {
        references_unfoldable_name(&ts_nn.expression, param_name, bound_names)
      }
      _ => false,
    },
    Expression::TSAsExpression(ts_as) => {
      references_unfoldable_name(&ts_as.expression, param_name, bound_names)
    }
    Expression::TSSatisfiesExpression(ts_sat) => {
      references_unfoldable_name(&ts_sat.expression, param_name, bound_names)
    }
    Expression::TSNonNullExpression(ts_nn) => {
      references_unfoldable_name(&ts_nn.expression, param_name, bound_names)
    }
    Expression::TSTypeAssertion(assertion) => {
      references_unfoldable_name(&assertion.expression, param_name, bound_names)
    }
    Expression::TSInstantiationExpression(instantiation) => {
      references_unfoldable_name(&instantiation.expression, param_name, bound_names)
    }
    Expression::SequenceExpression(seq) => seq
      .expressions
      .iter()
      .any(|e| references_unfoldable_name(e, param_name, bound_names)),
    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
      nested_callback_recursion_target(expr)
        .is_some_and(|body| references_unfoldable_name(body, param_name, bound_names))
    }
    _ => false,
  }
}

fn call_references_unfoldable_name(
  call: &CallExpression,
  param_name: &str,
  bound_names: &[String],
) -> bool {
  references_unfoldable_name(&call.callee, param_name, bound_names)
    || call.arguments.iter().any(|arg| {
      arg
        .as_expression()
        .is_some_and(|e| references_unfoldable_name(e, param_name, bound_names))
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

#[derive(Clone, Copy)]
enum ArrayMacroMethod {
  Map,
  FlatMap,
  Filter,
}

impl ArrayMacroMethod {
  fn name(self) -> &'static str {
    match self {
      ArrayMacroMethod::Map => "arrayMap",
      ArrayMacroMethod::FlatMap => "arrayFlatMap",
      ArrayMacroMethod::Filter => "arrayFilter",
    }
  }
}

fn evaluate_array_macro(
  method: ArrayMacroMethod,
  callee: &str,
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  let name = method.name();
  if callee != name || call.arguments.len() != 2 {
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
        format!("{}: callback must be an arrow function", name),
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if arrow.params.items.len() != 1 {
    let (line, character) = get_location(&file_ctx.line_index, callback.span().start);
    return Err(ConfTSError::new(
      format!("{}: callback must have exactly one parameter", name),
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let param_name = extract_param_name(&arrow.params.items[0].pattern, file_ctx, callback, name)?;

  let body_expr = get_arrow_body_expr(arrow, file_ctx, name)?;

  let items = match arr {
    Value::Array(items) => items,
    _ => return Ok(Some(Value::Array(Vec::new()))),
  };

  let mut result = Vec::new();
  for item in items {
    match method {
      ArrayMacroMethod::Map => {
        let mut local = HashMap::new();
        local.insert(param_name.clone(), item);
        let val = evaluate(body_expr, file_ctx, ctx, Some(&local), options)?;
        result.push(val);
      }
      ArrayMacroMethod::FlatMap => {
        let mut local = HashMap::new();
        local.insert(param_name.clone(), item);
        let val = evaluate(body_expr, file_ctx, ctx, Some(&local), options)?;
        match val {
          Value::Array(items) => result.extend(items),
          value => result.push(value),
        }
      }
      ArrayMacroMethod::Filter => {
        let mut local = HashMap::new();
        local.insert(param_name.clone(), item.clone());
        let val = evaluate(body_expr, file_ctx, ctx, Some(&local), options)?;
        if val.is_truthy() {
          result.push(item);
        }
      }
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

      if ch == '}' && stop_at_closing_brace && brace_depth == 0 {
        output.push(ch);
        *index += 1;
        return;
      }

      // The token renderer used by the TypeScript implementation never
      // emits formatting whitespace before closing punctuation, commas, or
      // member-access dots, nor after an opening bracket/brace or a unary
      // `!`/`~` operator (there is no binary use of either, so a lone `!`
      // or `~` immediately preceding whitespace is always a complete
      // token). Comments erased immediately next to one of those tokens
      // must not leave a native-only space behind, and user formatting
      // like `! (a & b)` or `!( a & b)` must collapse the same way the JS
      // token renderer does.
      if matches!(ch, ')' | ']' | '}' | ',' | '.')
        || matches!(output.chars().last(), Some('(' | '[' | '{' | '!' | '~'))
      {
        pending_space = false;
      } else {
        flush_space(output, &mut pending_space);
      }

      match ch {
        '\'' | '"' => copy_quoted(chars, index, output, ch),
        '`' => {
          if output.chars().last().is_some_and(|previous| {
            !previous.is_whitespace()
              && !matches!(previous, '.' | '(' | '[' | '{' | '!' | '~' | '+' | '-')
          }) {
            output.push(' ');
          }
          copy_template(chars, index, output);
        }
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
    Value::Undefined => Ok("undefined".to_string()),
    Value::Array(values) => Ok(format!(
      "[{}]",
      values
        .iter()
        .map(|value| value_to_expr_literal(value, file_ctx, offset, quote))
        .collect::<Result<Vec<_>, _>>()?
        .join(", ")
    )),
    Value::Object(values) => Ok(format!(
      "{{ {} }}",
      values
        .iter()
        .map(|(key, value)| {
          Ok(format!(
            "{}: {}",
            encode_string_literal(key, quote),
            value_to_expr_literal(value, file_ctx, offset, quote)?
          ))
        })
        .collect::<Result<Vec<_>, ConfTSError>>()?
        .join(", ")
    )),
  }
}

fn evaluate_expr_constant(
  expr: &Expression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let local = super::current_expr_template_bindings(ctx);
  evaluate(expr, file_ctx, ctx, local.as_ref(), options)
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

const NESTED_CALLBACK_ERROR: &str = "expr callback: a nested function passed as a call argument must have parameters that are plain identifiers (optionally defaulted) or a single level of object/array destructuring (optionally defaulted, no computed keys, no nested patterns), with at most one trailing rest parameter; it must not have type annotations, must not be async or a generator, and its body must be a single expression or a single return statement";

fn invalid_nested_callback_error(file_ctx: &FileContext, span_start: u32) -> ConfTSError {
  let (line, character) = get_location(&file_ctx.line_index, span_start);
  ConfTSError::new(NESTED_CALLBACK_ERROR, &file_ctx.file_path, line, character)
}

// Extracts the single body expression of a nested arrow/function callback
// (e.g. the predicate in `ctx.queue.filter(i => i < 5)`) if its body already
// has the shape collect_const_replacements accepts: a concise arrow
// expression, or a block containing exactly one `return` statement. Returns
// None for any other shape — call sites that need a hard error construct one
// themselves (via `nested_callback_body_expr` below); the handful that only
// need a best-effort peek (references_unfoldable_name and friends) just treat
// None as "nothing to recurse into".
fn nested_callback_body_expr_unchecked<'e, 'a>(
  body: &'e FunctionBody<'a>,
  is_concise: bool,
) -> Option<&'e Expression<'a>> {
  if is_concise {
    return match body.statements.first() {
      Some(Statement::ExpressionStatement(expr_stmt)) => Some(&expr_stmt.expression),
      _ => None,
    };
  }
  if body.statements.len() == 1
    && let Statement::ReturnStatement(ret) = &body.statements[0]
  {
    return ret.argument.as_ref();
  }
  None
}

// Dispatches nested_callback_body_expr_unchecked over whichever of the two
// nested-callback node kinds `expr` is (or None for anything else) — shared
// by every read-only pass that just needs to recurse into a callback's body
// without re-validating its shape (references_unfoldable_name,
// collect_type_syntax_erasures, collect_string_requotes,
// collect_context_replacements, validate_expr_syntax).
fn nested_callback_recursion_target<'e, 'a>(
  expr: &'e Expression<'a>,
) -> Option<&'e Expression<'a>> {
  match expr {
    Expression::ArrowFunctionExpression(arrow) => {
      nested_callback_body_expr_unchecked(&arrow.body, arrow.expression)
    }
    Expression::FunctionExpression(func) => func
      .body
      .as_ref()
      .and_then(|body| nested_callback_body_expr_unchecked(body, false)),
    _ => None,
  }
}

fn nested_callback_body_expr<'e, 'a>(
  body: &'e FunctionBody<'a>,
  is_concise: bool,
  file_ctx: &FileContext,
  error_span_start: u32,
) -> Result<&'e Expression<'a>, ConfTSError> {
  nested_callback_body_expr_unchecked(body, is_concise)
    .ok_or_else(|| invalid_nested_callback_error(file_ctx, error_span_start))
}

fn shadow_error(
  identifier: &BindingIdentifier,
  contextual_param_name: &str,
  file_ctx: &FileContext,
) -> ConfTSError {
  let (line, character) = get_location(&file_ctx.line_index, identifier.span.start);
  ConfTSError::new(
    format!(
      "expr callback: a nested function's parameter cannot shadow the context parameter '{}'",
      contextual_param_name
    ),
    &file_ctx.file_path,
    line,
    character,
  )
}

// Collects every identifier bound by a binding pattern, recursing one level
// into an object/array destructuring pattern — never deeper — and gathers
// any default-value expressions found along the way (a nested element's own
// `= expr`, via `BindingPattern::AssignmentPattern`) so the caller can fold
// them the same way the callback body is folded. Rest elements nested
// *inside* a pattern (`{a, ...rest}`, `[a, ...rest]`) aren't supported —
// only a top-level trailing parameter may be a rest parameter (see
// collect_nested_callback_params).
fn collect_binding_name_info<'a>(
  pattern: &'a BindingPattern<'a>,
  contextual_param_name: &str,
  file_ctx: &FileContext,
  allow_pattern: bool,
  names: &mut Vec<String>,
  default_expressions: &mut Vec<&'a Expression<'a>>,
) -> Result<(), ConfTSError> {
  match pattern {
    BindingPattern::BindingIdentifier(ident) => {
      if ident.name.as_str() == contextual_param_name {
        return Err(shadow_error(ident, contextual_param_name, file_ctx));
      }
      names.push(ident.name.as_str().to_string());
      Ok(())
    }
    BindingPattern::AssignmentPattern(assignment) => {
      collect_binding_name_info(
        &assignment.left,
        contextual_param_name,
        file_ctx,
        allow_pattern,
        names,
        default_expressions,
      )?;
      default_expressions.push(&assignment.right);
      Ok(())
    }
    BindingPattern::ObjectPattern(object) if allow_pattern => {
      if object.rest.is_some() {
        return Err(invalid_nested_callback_error(file_ctx, object.span.start));
      }
      for property in &object.properties {
        if property.computed {
          return Err(invalid_nested_callback_error(file_ctx, property.span.start));
        }
        collect_binding_name_info(
          &property.value,
          contextual_param_name,
          file_ctx,
          false,
          names,
          default_expressions,
        )?;
      }
      Ok(())
    }
    BindingPattern::ArrayPattern(array) if allow_pattern => {
      if array.rest.is_some() {
        return Err(invalid_nested_callback_error(file_ctx, array.span.start));
      }
      for element in &array.elements {
        let Some(element_pattern) = element else {
          continue; // hole, e.g. the middle slot in `[a, , b]`
        };
        collect_binding_name_info(
          element_pattern,
          contextual_param_name,
          file_ctx,
          false,
          names,
          default_expressions,
        )?;
      }
      Ok(())
    }
    _ => Err(invalid_nested_callback_error(
      file_ctx,
      pattern.span().start,
    )),
  }
}

// A default referencing an earlier parameter in the same list (real JS
// allows e.g. `(a, b = a + 1) => ...`) isn't supported: default expressions
// are resolved against the enclosing (ancestor) scope only, the same as any
// other expression outside this callback's own body.
fn collect_nested_callback_params<'a>(
  params: &'a FormalParameters<'a>,
  contextual_param_name: &str,
  file_ctx: &FileContext,
) -> Result<(Vec<String>, Vec<&'a Expression<'a>>), ConfTSError> {
  let mut names = Vec::with_capacity(params.items.len());
  let mut default_expressions: Vec<&'a Expression<'a>> = Vec::new();
  for item in &params.items {
    if item.type_annotation.is_some() {
      return Err(invalid_nested_callback_error(file_ctx, item.span.start));
    }
    collect_binding_name_info(
      &item.pattern,
      contextual_param_name,
      file_ctx,
      true,
      &mut names,
      &mut default_expressions,
    )?;
    if let Some(initializer) = &item.initializer {
      default_expressions.push(initializer);
    }
  }
  if let Some(rest) = &params.rest {
    if rest.type_annotation.is_some() {
      return Err(invalid_nested_callback_error(file_ctx, rest.span.start));
    }
    let BindingPattern::BindingIdentifier(ident) = &rest.rest.argument else {
      return Err(invalid_nested_callback_error(file_ctx, rest.span.start));
    };
    if ident.name.as_str() == contextual_param_name {
      return Err(shadow_error(ident, contextual_param_name, file_ctx));
    }
    names.push(ident.name.as_str().to_string());
  }
  Ok((names, default_expressions))
}

fn is_simple_single_identifier_params(params: &FormalParameters) -> bool {
  params.rest.is_none()
    && params.items.len() == 1
    && params.items[0].initializer.is_none()
    && matches!(
      params.items[0].pattern,
      BindingPattern::BindingIdentifier(_)
    )
}

// The end of the *last individual parameter* (or rest element) — unlike
// `FormalParameters::span`, which (per oxc, unlike TS's NodeArray
// convention) extends through the closing paren itself, so using it as a
// search-start would skip past that paren entirely.
fn last_param_end(params: &FormalParameters) -> Option<u32> {
  params
    .rest
    .as_ref()
    .map(|rest| rest.span.end)
    .or_else(|| params.items.last().map(|item| item.span.end))
}

// Mirrors macro-transformer/src/macro.ts's findParamListParens: identifiers
// and keywords can't contain '(' or ')', so the first '(' at/after the
// function's start is always the param list's own opening paren (skipping
// past `function`/a name for a FunctionExpression; arrows have nothing
// before it), and the first ')' at/after the end of the last parameter
// (which already spans past that parameter's own default value, so a paren
// inside a string literal there can't be mistaken for it) is always the
// closing one.
fn find_param_list_parens(
  source: &str,
  fn_start: u32,
  last_param_end: Option<u32>,
) -> Option<(u32, u32)> {
  let open_offset = source.get(fn_start as usize..)?.find('(')?;
  let open_pos = fn_start + open_offset as u32;
  let search_from = last_param_end.unwrap_or(open_pos + 1).max(open_pos + 1);
  let close_offset = source.get(search_from as usize..)?.find(')')?;
  Some((open_pos, search_from + close_offset as u32))
}

// Handles a nested arrow/function callback found while collecting
// const-replacements: down-levels its shell (`function (a) { return ... }` /
// `(a) => { return ...; }`) into plain `a => ...` text when needed, then
// recurses into the body with `params` pushed onto the expr-local-names
// stack so identifiers they bind aren't mistaken for compile-time constants.
#[allow(clippy::too_many_arguments)]
fn handle_nested_callback<'a>(
  node: &Expression<'a>,
  body_expr: &Expression<'a>,
  params: &[String],
  default_expressions: &[&Expression<'a>],
  is_simple_single_param: bool,
  needs_shell_rewrite: bool,
  last_param_end: Option<u32>,
  param_name: &str,
  bound_names: &[String],
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<(), ConfTSError> {
  // Default-value expressions can reference outer consts/context, so they
  // need the same treatment as the body — resolved against the ancestor
  // scope, since they run before any of this callback's own params exist.
  for default_expr in default_expressions {
    collect_const_replacements(
      default_expr,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    )?;
    // collect_const_replacements only folds constants — a bare `ctx.foo`
    // reference inside a default expression is deliberately left alone by
    // that pass (it's not a constant), so context.foo -> foo stripping has
    // to be applied here explicitly too, the same as it is for body_expr in
    // evaluate_expr below.
    collect_context_replacements(default_expr, param_name, body_start, replacements, file_ctx)?;
  }

  if needs_shell_rewrite {
    let fn_start = node.span().start;
    if is_simple_single_param {
      // Nothing in the param list to preserve — synthesize a minimal bare
      // `name => ` prefix rather than copying source text verbatim.
      let prefix_start = fn_start as usize - body_start as usize;
      let prefix_end = body_expr.span().start as usize - body_start as usize;
      replacements.push((prefix_start, prefix_end, format!("{} => ", params[0])));
    } else {
      // Anything more than a single plain identifier (destructuring,
      // defaults, rest, multiple params) always needs real parentheses in
      // valid JS, so keep that original `(...)` text — including whatever
      // nested replacements were just added inside it for default values —
      // instead of trying to reconstruct it from scratch.
      let source = file_ctx.parsed.source();
      let Some((open_pos, close_pos)) = find_param_list_parens(source, fn_start, last_param_end)
      else {
        return Err(invalid_nested_callback_error(file_ctx, fn_start));
      };
      if open_pos > fn_start {
        replacements.push((
          fn_start as usize - body_start as usize,
          open_pos as usize - body_start as usize,
          String::new(),
        ));
      }
      replacements.push((
        close_pos as usize + 1 - body_start as usize,
        body_expr.span().start as usize - body_start as usize,
        " => ".to_string(),
      ));
    }
    let suffix_start = body_expr.span().end as usize - body_start as usize;
    let suffix_end = node.span().end as usize - body_start as usize;
    replacements.push((suffix_start, suffix_end, String::new()));
  }
  // The body sees this callback's own params in addition to whatever was
  // already in scope from enclosing callbacks — extend, don't replace.
  let mut body_bound_names = bound_names.to_vec();
  body_bound_names.extend(params.iter().cloned());
  collect_const_replacements(
    body_expr,
    param_name,
    &body_bound_names,
    body_start,
    replacements,
    file_ctx,
    ctx,
    options,
  )
}

// The callee of a call is never itself invoked at compile time (the native
// evaluator has no general facility for executing arbitrary functions), so a
// member-access callee like `[1, 2].includes` or `someArray.includes` must be
// kept intact as runtime call syntax instead of being folded to a value the
// way a plain property-access value position would be (see the
// `Expression::StaticMemberExpression` arm of `collect_const_replacements`
// below, which does fold non-context-rooted property access to a value).
// Only the non-member base of the chain (and any computed keys) still need
// the normal constant-folding / context-substitution treatment.
#[allow(clippy::too_many_arguments)]
fn collect_call_callee_replacements(
  expr: &Expression,
  param_name: &str,
  bound_names: &[String],
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<(), ConfTSError> {
  match expr {
    Expression::StaticMemberExpression(member) => collect_call_callee_replacements(
      &member.object,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::ComputedMemberExpression(member) => {
      collect_call_callee_replacements(
        &member.object,
        param_name,
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &member.expression,
        param_name,
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }
    Expression::TSAsExpression(ts_as) => collect_call_callee_replacements(
      &ts_as.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSSatisfiesExpression(ts_sat) => collect_call_callee_replacements(
      &ts_sat.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSNonNullExpression(ts_nn) => collect_call_callee_replacements(
      &ts_nn.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSTypeAssertion(assertion) => collect_call_callee_replacements(
      &assertion.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::ParenthesizedExpression(paren) => collect_call_callee_replacements(
      &paren.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    _ => collect_const_replacements(
      expr,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
  }
}

// Normalizes the separator between a non-shorthand property's key and value
// to a plain `: ` (no space before, one space after) regardless of how the
// user's source spaced it — matching both the native encoder's usual style
// and the TypeScript transformer's fixed token-rendering output, so the two
// transformers stay byte-for-byte aligned even though this one only splices
// specific spans instead of re-rendering the whole expression from tokens.
fn normalize_property_colon(
  prop: &ObjectProperty,
  body_start: u32,
  source: &str,
  replacements: &mut Vec<ExprReplacement>,
) {
  let key_end = prop.key.span().end as usize;
  let value_start = prop.value.span().start as usize;
  // A computed key's `]` isn't part of `prop.key`'s span, so find it first
  // and anchor the replacement right after it instead of eating the bracket.
  let anchor = if prop.computed {
    match source[key_end..value_start].find(']') {
      Some(offset) => key_end + offset + 1,
      None => key_end,
    }
  } else {
    key_end
  };
  let start = anchor - body_start as usize;
  let end = value_start - body_start as usize;
  if start < end {
    replacements.push((start, end, ": ".to_string()));
  }
}

#[allow(clippy::too_many_arguments)]
fn collect_const_replacements(
  expr: &Expression,
  param_name: &str,
  bound_names: &[String],
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
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        );
      }
      // A base that touches the context param, or a name bound by an
      // enclosing nested callback, somewhere further down (e.g. a call
      // chain like `ctx.queue.filter(...).length`) can't be resolved to a
      // compile-time value — keep the member-access chain as runtime
      // source text instead, the same way a call's callee already is.
      if references_unfoldable_name(&member.object, param_name, bound_names) {
        return collect_call_callee_replacements(
          expr,
          param_name,
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        );
      }
      let value = evaluate_expr_constant(expr, file_ctx, ctx, options)?;
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
      let key_value = evaluate_expr_constant(&member.expression, file_ctx, ctx, options)?;
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

    Expression::ComputedMemberExpression(member) => {
      let root = get_member_root(&member.object);
      if matches!(root, Expression::Identifier(id) if id.name.as_str() == param_name) {
        collect_const_replacements(
          &member.object,
          param_name,
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
        return collect_const_replacements(
          &member.expression,
          param_name,
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        );
      }
      if references_unfoldable_name(&member.object, param_name, bound_names) {
        return collect_call_callee_replacements(
          expr,
          param_name,
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        );
      }
      let value = evaluate_expr_constant(expr, file_ctx, ctx, options)?;
      let literal = value_to_expr_literal(&value, file_ctx, expr.span().start, options.quote)?;
      let start = expr.span().start as usize - body_start as usize;
      let end = expr.span().end as usize - body_start as usize;
      replacements.push((start, end, literal));
      Ok(())
    }

    Expression::Identifier(ident)
      if ident.name.as_str() != param_name
        && !bound_names.iter().any(|name| name == ident.name.as_str()) =>
    {
      let value = evaluate_expr_constant(expr, file_ctx, ctx, options)?;
      let literal = value_to_expr_literal(&value, file_ctx, expr.span().start, options.quote)?;
      let start = expr.span().start as usize - body_start as usize;
      let end = expr.span().end as usize - body_start as usize;
      replacements.push((start, end, literal));
      Ok(())
    }

    Expression::ArrowFunctionExpression(arrow) => {
      if arrow.r#async || arrow.type_parameters.is_some() || arrow.return_type.is_some() {
        return Err(invalid_nested_callback_error(file_ctx, arrow.span.start));
      }
      let (params, default_expressions) =
        collect_nested_callback_params(&arrow.params, param_name, file_ctx)?;
      let body_expr =
        nested_callback_body_expr(&arrow.body, arrow.expression, file_ctx, arrow.span.start)?;
      let is_simple_single_param = is_simple_single_identifier_params(&arrow.params);
      handle_nested_callback(
        expr,
        body_expr,
        &params,
        &default_expressions,
        is_simple_single_param,
        !arrow.expression,
        last_param_end(&arrow.params),
        param_name,
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }

    Expression::FunctionExpression(func) => {
      if func.r#async
        || func.generator
        || func.type_parameters.is_some()
        || func.return_type.is_some()
      {
        return Err(invalid_nested_callback_error(file_ctx, func.span.start));
      }
      let Some(body) = &func.body else {
        return Err(invalid_nested_callback_error(file_ctx, func.span.start));
      };
      let (params, default_expressions) =
        collect_nested_callback_params(&func.params, param_name, file_ctx)?;
      let body_expr = nested_callback_body_expr(body, false, file_ctx, func.span.start)?;
      let is_simple_single_param = is_simple_single_identifier_params(&func.params);
      handle_nested_callback(
        expr,
        body_expr,
        &params,
        &default_expressions,
        is_simple_single_param,
        true,
        last_param_end(&func.params),
        param_name,
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )
    }

    Expression::CallExpression(call) => {
      if super::expression_originates_from_expr(&call.callee, file_ctx, ctx) {
        let valid_argument = call.arguments.len() == 1
          && matches!(
            call.arguments[0].as_expression(),
            Some(Expression::Identifier(identifier))
              if identifier.name.as_str() == param_name
          );
        if !valid_argument {
          let callee_name = compiler_native::eval::call_expr_callee_name(call);
          let (line, character) = get_location(&file_ctx.line_index, call.span.start);
          let error = ConfTSError::new(
            format!(
              "Nested Expr '{}' must be called with exactly one argument: the current expr context parameter '{}'.",
              callee_name, param_name
            ),
            &file_ctx.file_path,
            line,
            character,
          );
          super::record_fatal_transform_error(ctx, error.clone());
          return Err(error);
        }

        let value = evaluate_expr_constant(&call.callee, file_ctx, ctx, options)?;
        let Value::String(source) = value else {
          let callee_name = compiler_native::eval::call_expr_callee_name(call);
          let (line, character) = get_location(&file_ctx.line_index, call.span.start);
          return Err(ConfTSError::new(
            format!(
              "Nested Expr '{}' did not evaluate to an expression string",
              callee_name
            ),
            &file_ctx.file_path,
            line,
            character,
          ));
        };
        let start = expr.span().start as usize - body_start as usize;
        let end = expr.span().end as usize - body_start as usize;
        replacements.push((start, end, format!("({})", source)));
        return Ok(());
      }

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
          && references_unfoldable_name(expr, param_name, bound_names)
        {
          for arg in &call.arguments {
            if let Some(e) = arg.as_expression() {
              collect_const_replacements(
                e,
                param_name,
                bound_names,
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
        let value = evaluate_expr_constant(expr, file_ctx, ctx, options)?;
        let literal = value_to_expr_literal(&value, file_ctx, expr.span().start, options.quote)?;
        let start = expr.span().start as usize - body_start as usize;
        let end = expr.span().end as usize - body_start as usize;
        replacements.push((start, end, literal));
        return Ok(());
      }
      walk_const_children(
        expr,
        param_name,
        bound_names,
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
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
  }
}

#[allow(clippy::too_many_arguments)]
fn walk_const_children(
  expr: &Expression,
  param_name: &str,
  bound_names: &[String],
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
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &bin.right,
        param_name,
        bound_names,
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
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &log.right,
        param_name,
        bound_names,
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
      bound_names,
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
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &cond.consequent,
        param_name,
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &cond.alternate,
        param_name,
        bound_names,
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
      bound_names,
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
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
      }
      Ok(())
    }
    Expression::TaggedTemplateExpression(tagged) => {
      collect_const_replacements(
        &tagged.tag,
        param_name,
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      for expression in &tagged.quasi.expressions {
        collect_const_replacements(
          expression,
          param_name,
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
      }
      Ok(())
    }
    Expression::TSInstantiationExpression(instantiation) => collect_const_replacements(
      &instantiation.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::ArrayExpression(arr) => {
      for elem in &arr.elements {
        match elem {
          ArrayExpressionElement::SpreadElement(spread) => {
            collect_const_replacements(
              &spread.argument,
              param_name,
              bound_names,
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
                bound_names,
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
              if prop.computed {
                // `{ [DYNAMIC_KEY]: value }` — the key expression is itself a
                // value position (an outer const, context access, or bound
                // name) and needs the same treatment as the property's value.
                if let Some(key_expr) = prop.key.as_expression() {
                  collect_const_replacements(
                    key_expr,
                    param_name,
                    bound_names,
                    body_start,
                    replacements,
                    file_ctx,
                    ctx,
                    options,
                  )?;
                }
              }
              collect_const_replacements(
                &prop.value,
                param_name,
                bound_names,
                body_start,
                replacements,
                file_ctx,
                ctx,
                options,
              )?;
              normalize_property_colon(prop, body_start, file_ctx.parsed.source(), replacements);
              continue;
            }
            // Shorthand (`{ a }`): if `a` is the context param or a name
            // bound by an enclosing nested callback, it isn't a compile-time
            // constant — @conf-ts/expression understands shorthand properties
            // directly, so leave `{ a }` as runtime source text instead of
            // folding it. Otherwise (an outer compile-time const), expand it
            // to `a: <literal>`, matching the non-shorthand path above.
            if let Expression::Identifier(ident) = &prop.value {
              let is_unfoldable = ident.name.as_str() == param_name
                || bound_names.iter().any(|name| name == ident.name.as_str());
              if !is_unfoldable {
                let value = evaluate_expr_constant(&prop.value, file_ctx, ctx, options)?;
                let literal =
                  value_to_expr_literal(&value, file_ctx, prop.value.span().start, options.quote)?;
                let key_name = match &prop.key {
                  PropertyKey::StaticIdentifier(id) => id.name.as_str(),
                  _ => ident.name.as_str(),
                };
                let start = prop.span.start as usize - body_start as usize;
                let end = prop.span.end as usize - body_start as usize;
                let separator = if literal.starts_with('{') || literal.starts_with('[') {
                  ":"
                } else {
                  ": "
                };
                replacements.push((start, end, format!("{key_name}{separator}{literal}")));
              }
            }
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            collect_const_replacements(
              &spread.argument,
              param_name,
              bound_names,
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
      collect_call_callee_replacements(
        &call.callee,
        param_name,
        bound_names,
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
            bound_names,
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
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      )?;
      collect_const_replacements(
        &member.expression,
        param_name,
        bound_names,
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
        bound_names,
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
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )?;
        collect_const_replacements(
          &member.expression,
          param_name,
          bound_names,
          body_start,
          replacements,
          file_ctx,
          ctx,
          options,
        )
      }
      ChainElement::CallExpression(call) => {
        collect_call_callee_replacements(
          &call.callee,
          param_name,
          bound_names,
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
              bound_names,
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
      ChainElement::TSNonNullExpression(ts_non_null) => collect_const_replacements(
        &ts_non_null.expression,
        param_name,
        bound_names,
        body_start,
        replacements,
        file_ctx,
        ctx,
        options,
      ),
      _ => Ok(()),
    },
    Expression::TSAsExpression(ts_as) => collect_const_replacements(
      &ts_as.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSSatisfiesExpression(ts_sat) => collect_const_replacements(
      &ts_sat.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSNonNullExpression(ts_nn) => collect_const_replacements(
      &ts_nn.expression,
      param_name,
      bound_names,
      body_start,
      replacements,
      file_ctx,
      ctx,
      options,
    ),
    Expression::TSTypeAssertion(assertion) => collect_const_replacements(
      &assertion.expression,
      param_name,
      bound_names,
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
          bound_names,
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

// Prettier commonly puts a trailing comma after the last argument/property
// when it wraps a call or object literal onto multiple lines — very likely
// now that a single nested-callback argument (see handle_nested_callback
// above) can itself span several lines. Array literals are deliberately
// excluded: a trailing comma there can be a real elision (`[1, 2, ,]`), so
// erasing it could silently change the array's length/holes.
fn erase_trailing_comma(
  file_ctx: &FileContext,
  last_item_end: u32,
  container_end: u32,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
) {
  if container_end == 0 || container_end <= last_item_end {
    return;
  }
  let source = file_ctx.parsed.source();
  let closer_start = container_end as usize - 1;
  if closer_start > source.len() || last_item_end as usize > closer_start {
    return;
  }
  let gap = &source[last_item_end as usize..closer_start];
  let Some(comma_offset) = gap.find(',') else {
    return;
  };
  if gap.trim() != "," {
    return;
  }
  let comma_pos = last_item_end as usize + comma_offset;
  let start = comma_pos - body_start as usize;
  let end = start + 1;
  if !is_span_covered_by_prior(start, end, replacements) {
    replacements.push((start, end, String::new()));
  }
}

fn collect_type_syntax_erasures(
  expr: &Expression,
  body_start: u32,
  replacements: &mut Vec<ExprReplacement>,
  file_ctx: &FileContext,
) {
  let start = expr.span().start as usize - body_start as usize;
  let end = expr.span().end as usize - body_start as usize;
  if is_span_covered_by_prior(start, end, replacements) {
    return;
  }

  match expr {
    Expression::TSAsExpression(ts_as) => {
      replacements.push((
        ts_as.expression.span().end as usize - body_start as usize,
        ts_as.span.end as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&ts_as.expression, body_start, replacements, file_ctx);
    }
    Expression::TSSatisfiesExpression(ts_satisfies) => {
      replacements.push((
        ts_satisfies.expression.span().end as usize - body_start as usize,
        ts_satisfies.span.end as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&ts_satisfies.expression, body_start, replacements, file_ctx);
    }
    Expression::TSNonNullExpression(ts_non_null) => {
      replacements.push((
        ts_non_null.expression.span().end as usize - body_start as usize,
        ts_non_null.span.end as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&ts_non_null.expression, body_start, replacements, file_ctx);
    }
    Expression::TSTypeAssertion(assertion) => {
      replacements.push((
        assertion.span.start as usize - body_start as usize,
        assertion.expression.span().start as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(&assertion.expression, body_start, replacements, file_ctx);
    }
    Expression::BinaryExpression(binary) => {
      collect_type_syntax_erasures(&binary.left, body_start, replacements, file_ctx);
      collect_type_syntax_erasures(&binary.right, body_start, replacements, file_ctx);
    }
    Expression::LogicalExpression(logical) => {
      collect_type_syntax_erasures(&logical.left, body_start, replacements, file_ctx);
      collect_type_syntax_erasures(&logical.right, body_start, replacements, file_ctx);
    }
    Expression::UnaryExpression(unary) => {
      collect_type_syntax_erasures(&unary.argument, body_start, replacements, file_ctx);
    }
    Expression::ConditionalExpression(conditional) => {
      collect_type_syntax_erasures(&conditional.test, body_start, replacements, file_ctx);
      collect_type_syntax_erasures(&conditional.consequent, body_start, replacements, file_ctx);
      collect_type_syntax_erasures(&conditional.alternate, body_start, replacements, file_ctx);
    }
    Expression::ParenthesizedExpression(parenthesized) => {
      collect_type_syntax_erasures(
        &parenthesized.expression,
        body_start,
        replacements,
        file_ctx,
      );
    }
    Expression::StaticMemberExpression(member) => {
      collect_type_syntax_erasures(&member.object, body_start, replacements, file_ctx);
    }
    Expression::ComputedMemberExpression(member) => {
      collect_type_syntax_erasures(&member.object, body_start, replacements, file_ctx);
      collect_type_syntax_erasures(&member.expression, body_start, replacements, file_ctx);
    }
    Expression::CallExpression(call) => {
      if let Some(type_arguments) = &call.type_arguments {
        replacements.push((
          type_arguments.span.start as usize - body_start as usize,
          type_arguments.span.end as usize - body_start as usize,
          String::new(),
        ));
      }
      collect_type_syntax_erasures(&call.callee, body_start, replacements, file_ctx);
      for argument in &call.arguments {
        if let Some(expression) = argument.as_expression() {
          collect_type_syntax_erasures(expression, body_start, replacements, file_ctx);
        }
      }
      if let Some(last_arg) = call.arguments.last() {
        erase_trailing_comma(
          file_ctx,
          last_arg.span().end,
          call.span.end,
          body_start,
          replacements,
        );
      }
    }
    Expression::ChainExpression(chain) => match &chain.expression {
      ChainElement::StaticMemberExpression(member) => {
        collect_type_syntax_erasures(&member.object, body_start, replacements, file_ctx);
      }
      ChainElement::ComputedMemberExpression(member) => {
        collect_type_syntax_erasures(&member.object, body_start, replacements, file_ctx);
        collect_type_syntax_erasures(&member.expression, body_start, replacements, file_ctx);
      }
      ChainElement::CallExpression(call) => {
        if let Some(type_arguments) = &call.type_arguments {
          replacements.push((
            type_arguments.span.start as usize - body_start as usize,
            type_arguments.span.end as usize - body_start as usize,
            String::new(),
          ));
        }
        collect_type_syntax_erasures(&call.callee, body_start, replacements, file_ctx);
        for argument in &call.arguments {
          if let Some(expression) = argument.as_expression() {
            collect_type_syntax_erasures(expression, body_start, replacements, file_ctx);
          }
        }
        if let Some(last_arg) = call.arguments.last() {
          erase_trailing_comma(
            file_ctx,
            last_arg.span().end,
            call.span.end,
            body_start,
            replacements,
          );
        }
      }
      ChainElement::TSNonNullExpression(ts_non_null) => {
        replacements.push((
          ts_non_null.expression.span().end as usize - body_start as usize,
          ts_non_null.span.end as usize - body_start as usize,
          String::new(),
        ));
        collect_type_syntax_erasures(&ts_non_null.expression, body_start, replacements, file_ctx);
      }
      _ => {}
    },
    Expression::ArrayExpression(array) => {
      for element in &array.elements {
        if let Some(expression) = element.as_expression() {
          collect_type_syntax_erasures(expression, body_start, replacements, file_ctx);
        }
      }
    }
    Expression::ObjectExpression(object) => {
      for property in &object.properties {
        match property {
          ObjectPropertyKind::ObjectProperty(property) => {
            collect_type_syntax_erasures(&property.value, body_start, replacements, file_ctx);
          }
          ObjectPropertyKind::SpreadProperty(spread) => {
            collect_type_syntax_erasures(&spread.argument, body_start, replacements, file_ctx);
          }
        }
      }
      if let Some(last_property) = object.properties.last() {
        erase_trailing_comma(
          file_ctx,
          last_property.span().end,
          object.span.end,
          body_start,
          replacements,
        );
      }
    }
    Expression::TemplateLiteral(template) => {
      for expression in &template.expressions {
        collect_type_syntax_erasures(expression, body_start, replacements, file_ctx);
      }
    }
    Expression::TaggedTemplateExpression(tagged) => {
      if let Some(type_arguments) = &tagged.type_arguments {
        replacements.push((
          type_arguments.span.start as usize - body_start as usize,
          type_arguments.span.end as usize - body_start as usize,
          String::new(),
        ));
      }
      collect_type_syntax_erasures(&tagged.tag, body_start, replacements, file_ctx);
      for expression in &tagged.quasi.expressions {
        collect_type_syntax_erasures(expression, body_start, replacements, file_ctx);
      }
    }
    Expression::TSInstantiationExpression(instantiation) => {
      replacements.push((
        instantiation.type_arguments.span.start as usize - body_start as usize,
        instantiation.type_arguments.span.end as usize - body_start as usize,
        String::new(),
      ));
      collect_type_syntax_erasures(
        &instantiation.expression,
        body_start,
        replacements,
        file_ctx,
      );
    }
    Expression::SequenceExpression(sequence) => {
      for expression in &sequence.expressions {
        collect_type_syntax_erasures(expression, body_start, replacements, file_ctx);
      }
    }
    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
      if let Some(body_expr) = nested_callback_recursion_target(expr) {
        collect_type_syntax_erasures(body_expr, body_start, replacements, file_ctx);
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

fn collect_comment_erasures(
  file_ctx: &FileContext,
  body_start: u32,
  body_end: u32,
  replacements: &mut Vec<ExprReplacement>,
) {
  for comment in &file_ctx.program().comments {
    if comment.span.start < body_start || comment.span.end > body_end {
      continue;
    }
    let start = comment.span.start as usize - body_start as usize;
    let end = comment.span.end as usize - body_start as usize;
    if !is_span_covered_by_prior(start, end, replacements) {
      replacements.push((start, end, String::new()));
    }
  }
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
    Expression::TSInstantiationExpression(instantiation) => {
      collect_string_requotes(&instantiation.expression, body_start, prior, out, quote);
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
    Expression::TaggedTemplateExpression(tagged) => {
      collect_string_requotes(&tagged.tag, body_start, prior, out, quote);
      for expression in &tagged.quasi.expressions {
        collect_string_requotes(expression, body_start, prior, out, quote);
      }
    }
    Expression::SequenceExpression(sequence) => {
      for expression in &sequence.expressions {
        collect_string_requotes(expression, body_start, prior, out, quote);
      }
    }
    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
      if let Some(body_expr) = nested_callback_recursion_target(expr) {
        collect_string_requotes(body_expr, body_start, prior, out, quote);
      }
    }
    _ => {}
  }
}

pub(crate) const EXPR_TEMPLATE_PLACEHOLDER: &str = "(() => { throw new Error(\"exprTemplate is compile-time-only and must be invoked with statically analyzable arguments\"); })";

const EXPR_TEMPLATE_CALLBACK_ERROR: &str = "exprTemplate callback must be a synchronous arrow function whose first parameter is a plain context identifier and whose body is a single expression";
const EXPR_TEMPLATE_PARAMETER_ERROR: &str = "exprTemplate parameters after the context must be identifiers, optional/defaulted identifiers, a single level of object/array destructuring, or a trailing rest parameter";

fn unwrap_expr_template_expression<'e, 'a>(expression: &'e Expression<'a>) -> &'e Expression<'a> {
  match expression {
    Expression::ParenthesizedExpression(value) => {
      unwrap_expr_template_expression(&value.expression)
    }
    Expression::TSAsExpression(value) => unwrap_expr_template_expression(&value.expression),
    Expression::TSSatisfiesExpression(value) => unwrap_expr_template_expression(&value.expression),
    Expression::TSNonNullExpression(value) => unwrap_expr_template_expression(&value.expression),
    Expression::TSTypeAssertion(value) => unwrap_expr_template_expression(&value.expression),
    _ => expression,
  }
}

fn expr_template_error(
  file_ctx: &FileContext,
  offset: u32,
  message: impl Into<String>,
) -> ConfTSError {
  let (line, character) = get_location(&file_ctx.line_index, offset);
  ConfTSError::new(message.into(), &file_ctx.file_path, line, character)
}

fn expr_template_callback<'e, 'a>(
  call: &'e CallExpression<'a>,
  file_ctx: &FileContext,
) -> Result<&'e ArrowFunctionExpression<'a>, ConfTSError> {
  if call.arguments.len() != 1 {
    return Err(expr_template_error(
      file_ctx,
      call.span.start,
      EXPR_TEMPLATE_CALLBACK_ERROR,
    ));
  }
  let callback = call.arguments[0].as_expression().ok_or_else(|| {
    expr_template_error(
      file_ctx,
      call.arguments[0].span().start,
      EXPR_TEMPLATE_CALLBACK_ERROR,
    )
  })?;
  let Expression::ArrowFunctionExpression(arrow) = unwrap_expr_template_expression(callback) else {
    return Err(expr_template_error(
      file_ctx,
      callback.span().start,
      EXPR_TEMPLATE_CALLBACK_ERROR,
    ));
  };
  if arrow.r#async
    || !arrow.expression
    || arrow.params.items.is_empty()
    || arrow.params.items[0].initializer.is_some()
    || arrow.params.items[0].optional
    || !matches!(
      arrow.params.items[0].pattern,
      BindingPattern::BindingIdentifier(_)
    )
  {
    return Err(expr_template_error(
      file_ctx,
      arrow.span.start,
      EXPR_TEMPLATE_CALLBACK_ERROR,
    ));
  }
  Ok(arrow.as_ref())
}

pub(crate) fn validate_expr_template_definition(
  call: &CallExpression,
  file_ctx: &FileContext,
) -> Result<(), ConfTSError> {
  expr_template_callback(call, file_ctx).map(|_| ())
}

fn find_expr_template_call_in_expression<'e, 'a>(
  expression: &'e Expression<'a>,
  call_start: u32,
) -> Option<&'e CallExpression<'a>> {
  match unwrap_expr_template_expression(expression) {
    Expression::CallExpression(call) => {
      if call.span.start == call_start {
        return Some(call.as_ref());
      }
      find_expr_template_call_in_expression(&call.callee, call_start)
    }
    _ => None,
  }
}

fn find_expr_template_call<'e, 'a>(
  file_ctx: &'e FileContext,
  call_start: u32,
) -> Option<&'e CallExpression<'a>>
where
  'e: 'a,
{
  fn from_declaration<'e, 'a>(
    declaration: &'e VariableDeclaration<'a>,
    call_start: u32,
  ) -> Option<&'e CallExpression<'a>> {
    declaration.declarations.iter().find_map(|declarator| {
      declarator
        .init
        .as_ref()
        .and_then(|expression| find_expr_template_call_in_expression(expression, call_start))
    })
  }

  for statement in &file_ctx.program().body {
    match statement {
      Statement::VariableDeclaration(declaration) => {
        if let Some(call) = from_declaration(declaration, call_start) {
          return Some(call);
        }
      }
      Statement::ExportNamedDeclaration(export) => {
        if let Some(Declaration::VariableDeclaration(declaration)) = &export.declaration
          && let Some(call) = from_declaration(declaration, call_start)
        {
          return Some(call);
        }
      }
      Statement::ExportDefaultDeclaration(export) => {
        if let Some(expression) = export.declaration.as_expression()
          && let Some(call) = find_expr_template_call_in_expression(expression, call_start)
        {
          return Some(call);
        }
      }
      _ => {}
    }
  }
  None
}

fn static_binding_key(property: &BindingProperty) -> Option<String> {
  if property.computed {
    return None;
  }
  match &property.key {
    PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.as_str().to_string()),
    PropertyKey::StringLiteral(string) => Some(string.value.as_str().to_string()),
    PropertyKey::NumericLiteral(number) => Some(number.value.to_string()),
    _ => None,
  }
}

fn object_entries(value: &Value) -> Vec<(String, Value)> {
  match value {
    Value::Object(entries) => entries.clone(),
    Value::Array(values) => values
      .iter()
      .enumerate()
      .map(|(index, value)| (index.to_string(), value.clone()))
      .collect(),
    Value::String(value) => value
      .chars()
      .enumerate()
      .map(|(index, value)| (index.to_string(), Value::String(value.to_string())))
      .collect(),
    _ => Vec::new(),
  }
}

fn binding_property_value(value: &Value, key: &str) -> Value {
  match value {
    Value::Object(entries) => entries
      .iter()
      .find(|(entry_key, _)| entry_key == key)
      .map(|(_, value)| value.clone())
      .unwrap_or(Value::Undefined),
    Value::Array(values) => {
      if key == "length" {
        Value::number(values.len() as f64)
      } else {
        key
          .parse::<usize>()
          .ok()
          .and_then(|index| values.get(index).cloned())
          .unwrap_or(Value::Undefined)
      }
    }
    Value::String(value) => {
      if key == "length" {
        Value::number(value.chars().count() as f64)
      } else {
        key
          .parse::<usize>()
          .ok()
          .and_then(|index| value.chars().nth(index))
          .map(|character| Value::String(character.to_string()))
          .unwrap_or(Value::Undefined)
      }
    }
    _ => Value::Undefined,
  }
}

fn bind_expr_template_pattern(
  pattern: &BindingPattern,
  mut value: Value,
  allow_pattern: bool,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  bindings: &mut HashMap<String, Value>,
  options: &CompileOptions,
) -> Result<(), ConfTSError> {
  if let BindingPattern::AssignmentPattern(assignment) = pattern {
    if matches!(value, Value::Undefined) {
      value = evaluate(&assignment.right, file_ctx, ctx, Some(bindings), options)?;
    }
    return bind_expr_template_pattern(
      &assignment.left,
      value,
      false,
      file_ctx,
      ctx,
      bindings,
      options,
    );
  }

  match pattern {
    BindingPattern::BindingIdentifier(identifier) => {
      bindings.insert(identifier.name.as_str().to_string(), value);
      Ok(())
    }
    BindingPattern::ObjectPattern(object) if allow_pattern => {
      if matches!(value, Value::Null | Value::Undefined) {
        return Err(expr_template_error(
          file_ctx,
          object.span.start,
          "exprTemplate cannot destructure null or undefined",
        ));
      }
      let mut used = Vec::new();
      for property in &object.properties {
        let Some(key) = static_binding_key(property) else {
          return Err(expr_template_error(
            file_ctx,
            property.span.start,
            EXPR_TEMPLATE_PARAMETER_ERROR,
          ));
        };
        let property_value = binding_property_value(&value, &key);
        used.push(key);
        bind_expr_template_pattern(
          &property.value,
          property_value,
          false,
          file_ctx,
          ctx,
          bindings,
          options,
        )?;
      }
      if let Some(rest) = &object.rest {
        let BindingPattern::BindingIdentifier(identifier) = &rest.argument else {
          return Err(expr_template_error(
            file_ctx,
            rest.span.start,
            EXPR_TEMPLATE_PARAMETER_ERROR,
          ));
        };
        let remaining = object_entries(&value)
          .into_iter()
          .filter(|(key, _)| !used.contains(key))
          .collect();
        bindings.insert(
          identifier.name.as_str().to_string(),
          Value::Object(remaining),
        );
      }
      Ok(())
    }
    BindingPattern::ArrayPattern(array) if allow_pattern => {
      let values = match value {
        Value::Array(values) => values,
        Value::String(value) => value
          .chars()
          .map(|character| Value::String(character.to_string()))
          .collect(),
        _ => {
          return Err(expr_template_error(
            file_ctx,
            array.span.start,
            "exprTemplate array destructuring requires a statically analyzable array or string",
          ));
        }
      };
      for (index, element) in array.elements.iter().enumerate() {
        if let Some(element) = element {
          bind_expr_template_pattern(
            element,
            values.get(index).cloned().unwrap_or(Value::Undefined),
            false,
            file_ctx,
            ctx,
            bindings,
            options,
          )?;
        }
      }
      if let Some(rest) = &array.rest {
        let BindingPattern::BindingIdentifier(identifier) = &rest.argument else {
          return Err(expr_template_error(
            file_ctx,
            rest.span.start,
            EXPR_TEMPLATE_PARAMETER_ERROR,
          ));
        };
        bindings.insert(
          identifier.name.as_str().to_string(),
          Value::Array(values.into_iter().skip(array.elements.len()).collect()),
        );
      }
      Ok(())
    }
    _ => Err(expr_template_error(
      file_ctx,
      pattern.span().start,
      EXPR_TEMPLATE_PARAMETER_ERROR,
    )),
  }
}

fn evaluate_expr_template_invocation(
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  let Some(definition) = super::expr_template_definition(&call.callee, file_ctx, ctx) else {
    return Ok(None);
  };
  for dependency in definition.dependencies {
    ctx.evaluated_files.insert(dependency);
  }

  let definition_ctx = ctx
    .file_contexts
    .get(&definition.file_path)
    .cloned()
    .ok_or_else(|| {
      expr_template_error(
        file_ctx,
        call.span.start,
        "exprTemplate definition file is unavailable",
      )
    })?;
  let definition_call = find_expr_template_call(&definition_ctx, definition.call_start)
    .ok_or_else(|| {
      expr_template_error(
        &definition_ctx,
        definition.call_start,
        "exprTemplate definition could not be resolved",
      )
    })?;
  let arrow = expr_template_callback(definition_call, &definition_ctx)?;

  let mut values = Vec::new();
  for argument in &call.arguments {
    match argument {
      Argument::SpreadElement(spread) => {
        let value = evaluate(&spread.argument, file_ctx, ctx, local_context, options)?;
        let Value::Array(spread_values) = value else {
          return Err(expr_template_error(
            file_ctx,
            spread.span.start,
            "exprTemplate spread arguments must resolve to an array",
          ));
        };
        values.extend(spread_values);
      }
      _ => {
        let expression = argument.as_expression().ok_or_else(|| {
          expr_template_error(
            file_ctx,
            argument.span().start,
            "exprTemplate arguments must be statically analyzable",
          )
        })?;
        values.push(evaluate(expression, file_ctx, ctx, local_context, options)?);
      }
    }
  }

  let parameters = &arrow.params.items[1..];
  let minimum = parameters
    .iter()
    .enumerate()
    .filter(|(_, parameter)| !parameter.optional && parameter.initializer.is_none())
    .map(|(index, _)| index + 1)
    .max()
    .unwrap_or(0);
  if values.len() < minimum {
    return Err(expr_template_error(
      file_ctx,
      call.span.start,
      format!(
        "exprTemplate expected at least {} static argument(s), but received {}",
        minimum,
        values.len()
      ),
    ));
  }
  if arrow.params.rest.is_none() && values.len() > parameters.len() {
    return Err(expr_template_error(
      file_ctx,
      call.span.start,
      format!(
        "exprTemplate expected at most {} static argument(s), but received {}",
        parameters.len(),
        values.len()
      ),
    ));
  }

  let mut bindings = HashMap::new();
  for (index, parameter) in parameters.iter().enumerate() {
    let mut value = values.get(index).cloned().unwrap_or(Value::Undefined);
    if matches!(value, Value::Undefined)
      && let Some(initializer) = &parameter.initializer
    {
      value = evaluate(initializer, &definition_ctx, ctx, Some(&bindings), options)?;
    }
    bind_expr_template_pattern(
      &parameter.pattern,
      value,
      true,
      &definition_ctx,
      ctx,
      &mut bindings,
      options,
    )?;
  }
  if let Some(rest) = &arrow.params.rest {
    let BindingPattern::BindingIdentifier(identifier) = &rest.rest.argument else {
      return Err(expr_template_error(
        &definition_ctx,
        rest.span.start,
        EXPR_TEMPLATE_PARAMETER_ERROR,
      ));
    };
    bindings.insert(
      identifier.name.as_str().to_string(),
      Value::Array(values.into_iter().skip(parameters.len()).collect()),
    );
  }

  let context_name = match &arrow.params.items[0].pattern {
    BindingPattern::BindingIdentifier(identifier) => identifier.name.as_str(),
    _ => unreachable!(),
  };
  let body_expr = match arrow.body.statements.first() {
    Some(Statement::ExpressionStatement(statement)) => &statement.expression,
    _ => {
      return Err(expr_template_error(
        &definition_ctx,
        arrow.body.span.start,
        EXPR_TEMPLATE_CALLBACK_ERROR,
      ));
    }
  };

  super::push_expr_template_bindings(ctx, bindings);
  let result = compile_expr_arrow(
    arrow,
    context_name,
    body_expr,
    &definition_ctx,
    ctx,
    options,
  );
  super::pop_expr_template_bindings(ctx);
  result.map(Some)
}

fn compile_expr_arrow(
  arrow: &ArrowFunctionExpression,
  param_name: &str,
  body_expr: &Expression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  validate_expr_syntax(body_expr, file_ctx)?;

  let source = file_ctx.parsed.source();
  let body_start = body_expr.span().start;
  let body_text = &source[body_start as usize..body_expr.span().end as usize];

  let mut replacements: Vec<ExprReplacement> = Vec::new();
  collect_const_replacements(
    body_expr,
    param_name,
    &[],
    body_start,
    &mut replacements,
    file_ctx,
    ctx,
    options,
  )?;
  collect_context_replacements(
    body_expr,
    param_name,
    body_start,
    &mut replacements,
    file_ctx,
  )?;
  collect_type_syntax_erasures(body_expr, body_start, &mut replacements, file_ctx);
  collect_comment_erasures(
    file_ctx,
    body_start,
    body_expr.span().end,
    &mut replacements,
  );
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

  let _ = arrow;
  Ok(Value::String(compact_expression_whitespace(&result)))
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

  compile_expr_arrow(arrow, &param_name, body_expr, file_ctx, ctx, options).map(Some)
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
  let start = expr.span().start as usize - body_start as usize;
  let end = expr.span().end as usize - body_start as usize;
  if is_span_covered_by_prior(start, end, replacements) {
    return Ok(());
  }

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
    Expression::TaggedTemplateExpression(tagged) => {
      collect_context_replacements(&tagged.tag, param_name, body_start, replacements, file_ctx)?;
      for expression in &tagged.quasi.expressions {
        collect_context_replacements(expression, param_name, body_start, replacements, file_ctx)?;
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
            // A shorthand value is just the bare identifier again (`{ a }`
            // has no member access to strip), but still worth visiting so a
            // shorthand of the bare context param itself (`{ ctx }`) hits the
            // same "cannot use the context parameter directly" check below.
            collect_context_replacements(
              &prop.value,
              param_name,
              body_start,
              replacements,
              file_ctx,
            )?;
            if prop.computed {
              // `{ [ctx.key]: value }` — the key expression can itself
              // reference the context and needs the same stripping.
              if let Some(key_expr) = prop.key.as_expression() {
                collect_context_replacements(
                  key_expr,
                  param_name,
                  body_start,
                  replacements,
                  file_ctx,
                )?;
              }
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
      ChainElement::TSNonNullExpression(ts_non_null) => collect_context_replacements(
        &ts_non_null.expression,
        param_name,
        body_start,
        replacements,
        file_ctx,
      ),
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
    Expression::TSInstantiationExpression(instantiation) => collect_context_replacements(
      &instantiation.expression,
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
    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
      match nested_callback_recursion_target(expr) {
        Some(body_expr) => {
          collect_context_replacements(body_expr, param_name, body_start, replacements, file_ctx)
        }
        None => Ok(()),
      }
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
    Expression::TaggedTemplateExpression(tagged) => {
      validate_expr_syntax(&tagged.tag, file_ctx)?;
      for expression in &tagged.quasi.expressions {
        validate_expr_syntax(expression, file_ctx)?;
      }
      Ok(())
    }
    Expression::TSAsExpression(ts_as) => validate_expr_syntax(&ts_as.expression, file_ctx),
    Expression::TSSatisfiesExpression(ts_sat) => validate_expr_syntax(&ts_sat.expression, file_ctx),
    Expression::TSNonNullExpression(ts_nn) => validate_expr_syntax(&ts_nn.expression, file_ctx),
    Expression::TSTypeAssertion(assertion) => validate_expr_syntax(&assertion.expression, file_ctx),
    Expression::TSInstantiationExpression(instantiation) => {
      validate_expr_syntax(&instantiation.expression, file_ctx)
    }
    Expression::SequenceExpression(seq) => {
      for e in &seq.expressions {
        validate_expr_syntax(e, file_ctx)?;
      }
      Ok(())
    }
    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
      match nested_callback_recursion_target(expr) {
        Some(body_expr) => validate_expr_syntax(body_expr, file_ctx),
        // Malformed shapes surface later, with a clearer message, from
        // collect_const_replacements.
        None => Ok(()),
      }
    }
    _ => Ok(()),
  }
}
