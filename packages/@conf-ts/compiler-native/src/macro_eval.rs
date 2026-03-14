use std::collections::HashMap;

use swc_common::Spanned;
use swc_ecma_ast::*;

use crate::error::ConfTSError;
use crate::eval::{EvalContext, call_expr_callee_name, evaluate, get_location};
use crate::types::{CompileOptions, FileContext, Value};

/// Evaluate a macro call expression.
pub fn evaluate_macro(
  call: &CallExpr,
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
  if let Some(val) = evaluate_array_filter(&callee, call, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }
  if let Some(val) = evaluate_env(&callee, call, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }

  let (line, character) = get_location(&file_ctx.source_map, call.span.lo);
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
  call: &CallExpr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "String" && callee != "Number" && callee != "Boolean" {
    return Ok(None);
  }
  if call.args.len() != 1 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.source_map, call.span.lo);
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

  let arg = evaluate(&call.args[0].expr, file_ctx, ctx, local_context, options)?;
  match callee {
    "String" => Ok(Some(Value::String(arg.to_display_string()))),
    "Number" => Ok(Some(Value::number(arg.to_number()))),
    "Boolean" => Ok(Some(Value::Bool(arg.is_truthy()))),
    _ => Ok(None),
  }
}

fn evaluate_env(
  callee: &str,
  call: &CallExpr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "env" {
    return Ok(None);
  }
  if call.args.len() != 1 && call.args.len() != 2 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.source_map, call.span.lo);
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

  let arg = evaluate(&call.args[0].expr, file_ctx, ctx, local_context, options)?;
  let env_key = match &arg {
    Value::String(s) => s.clone(),
    _ => {
      let (line, character) = get_location(&file_ctx.source_map, call.args[0].expr.span().lo);
      return Err(ConfTSError::new(
        "env macro argument must be a string",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  let default_value = if call.args.len() == 2 {
    let val = evaluate(&call.args[1].expr, file_ctx, ctx, local_context, options)?;
    match &val {
      Value::String(_) | Value::Undefined => Some(val),
      _ => {
        let (line, character) = get_location(&file_ctx.source_map, call.args[1].expr.span().lo);
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
  call: &CallExpr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "arrayMap" || call.args.len() != 2 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.source_map, call.span.lo);
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

  let arr = evaluate(&call.args[0].expr, file_ctx, ctx, local_context, options)?;
  let callback = &call.args[1].expr;
  let arrow = match callback.as_ref() {
    Expr::Arrow(arrow) => arrow,
    _ => {
      let (line, character) = get_location(&file_ctx.source_map, callback.span().lo);
      return Err(ConfTSError::new(
        "arrayMap: callback must be an arrow function",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if arrow.params.len() != 1 {
    let (line, character) = get_location(&file_ctx.source_map, callback.span().lo);
    return Err(ConfTSError::new(
      "arrayMap: callback must have exactly one parameter",
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let param_name = match &arrow.params[0] {
    Pat::Ident(ident) => ident.id.sym.as_str().to_string(),
    _ => {
      let (line, character) = get_location(&file_ctx.source_map, callback.span().lo);
      return Err(ConfTSError::new(
        "arrayMap: callback parameter must be an identifier",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  let body_expr = get_arrow_body_expr(arrow, file_ctx, "arrayMap")?;
  validate_callback_body(body_expr, &param_name, file_ctx, ctx, "arrayMap")?;

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

fn evaluate_array_filter(
  callee: &str,
  call: &CallExpr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if callee != "arrayFilter" || call.args.len() != 2 {
    return Ok(None);
  }

  if !check_macro_import(callee, ctx, &file_ctx.file_path) {
    let (line, character) = get_location(&file_ctx.source_map, call.span.lo);
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

  let arr = evaluate(&call.args[0].expr, file_ctx, ctx, local_context, options)?;
  let callback = &call.args[1].expr;
  let arrow = match callback.as_ref() {
    Expr::Arrow(arrow) => arrow,
    _ => {
      let (line, character) = get_location(&file_ctx.source_map, callback.span().lo);
      return Err(ConfTSError::new(
        "arrayFilter: callback must be an arrow function",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  if arrow.params.len() != 1 {
    let (line, character) = get_location(&file_ctx.source_map, callback.span().lo);
    return Err(ConfTSError::new(
      "arrayFilter: callback must have exactly one parameter",
      &file_ctx.file_path,
      line,
      character,
    ));
  }

  let param_name = match &arrow.params[0] {
    Pat::Ident(ident) => ident.id.sym.as_str().to_string(),
    _ => {
      let (line, character) = get_location(&file_ctx.source_map, callback.span().lo);
      return Err(ConfTSError::new(
        "arrayFilter: callback parameter must be an identifier",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  let body_expr = get_arrow_body_expr(arrow, file_ctx, "arrayFilter")?;
  validate_callback_body(body_expr, &param_name, file_ctx, ctx, "arrayFilter")?;

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

fn get_arrow_body_expr<'a>(
  arrow: &'a ArrowExpr,
  file_ctx: &FileContext,
  macro_name: &str,
) -> Result<&'a Expr, ConfTSError> {
  match &*arrow.body {
    BlockStmtOrExpr::Expr(expr) => Ok(expr),
    BlockStmtOrExpr::BlockStmt(block) => {
      if block.stmts.len() != 1 {
        let (line, character) = get_location(&file_ctx.source_map, block.span.lo);
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
      match &block.stmts[0] {
        Stmt::Return(ret) => match &ret.arg {
          Some(expr) => Ok(expr),
          None => {
            let (line, character) = get_location(&file_ctx.source_map, block.span.lo);
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
          let (line, character) = get_location(&file_ctx.source_map, block.span.lo);
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
  }
}

fn validate_callback_body(
  expr: &Expr,
  param_name: &str,
  file_ctx: &FileContext,
  ctx: &EvalContext,
  macro_name: &str,
) -> Result<(), ConfTSError> {
  validate_node(expr, param_name, file_ctx, ctx, macro_name)
}

fn validate_node(
  expr: &Expr,
  param_name: &str,
  file_ctx: &FileContext,
  ctx: &EvalContext,
  macro_name: &str,
) -> Result<(), ConfTSError> {
  match expr {
    Expr::Ident(ident) => {
      let name = ident.sym.as_str();
      if name == param_name {
        return Ok(());
      }
      let (line, character) = get_location(&file_ctx.source_map, ident.span.lo);
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
    Expr::Lit(_) => Ok(()),
    Expr::Member(member) => {
      if is_enum_member_access(member, ctx) {
        return Ok(());
      }
      if is_param_chain(&member.obj, param_name) {
        return Ok(());
      }
      validate_node(&member.obj, param_name, file_ctx, ctx, macro_name)?;
      if let MemberProp::Computed(comp) = &member.prop {
        validate_node(&comp.expr, param_name, file_ctx, ctx, macro_name)?;
      }
      Ok(())
    }
    Expr::Object(obj) => {
      for prop in &obj.props {
        match prop {
          PropOrSpread::Prop(p) => match p.as_ref() {
            Prop::KeyValue(kv) => {
              validate_node(&kv.value, param_name, file_ctx, ctx, macro_name)?;
            }
            Prop::Shorthand(ident) => {
              if ident.sym.as_str() != param_name {
                let (line, character) = get_location(&file_ctx.source_map, ident.span.lo);
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
            _ => {}
          },
          PropOrSpread::Spread(spread) => {
            validate_node(&spread.expr, param_name, file_ctx, ctx, macro_name)?;
          }
        }
      }
      Ok(())
    }
    Expr::Array(arr) => {
      for elem in &arr.elems {
        if let Some(e) = elem {
          validate_node(&e.expr, param_name, file_ctx, ctx, macro_name)?;
        }
      }
      Ok(())
    }
    Expr::Bin(bin) => {
      validate_node(&bin.left, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&bin.right, param_name, file_ctx, ctx, macro_name)
    }
    Expr::Unary(unary) => validate_node(&unary.arg, param_name, file_ctx, ctx, macro_name),
    Expr::Paren(paren) => validate_node(&paren.expr, param_name, file_ctx, ctx, macro_name),
    Expr::Cond(cond) => {
      validate_node(&cond.test, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&cond.cons, param_name, file_ctx, ctx, macro_name)?;
      validate_node(&cond.alt, param_name, file_ctx, ctx, macro_name)
    }
    Expr::Tpl(tpl) => {
      for e in &tpl.exprs {
        validate_node(e, param_name, file_ctx, ctx, macro_name)?;
      }
      Ok(())
    }
    Expr::Call(call) => {
      let callee_name = call_expr_callee_name(call);
      let macro_imports = ctx
        .macro_imports_map
        .get(&file_ctx.file_path)
        .cloned()
        .unwrap_or_default();
      if macro_imports.contains(&callee_name) {
        for arg in &call.args {
          validate_node(&arg.expr, param_name, file_ctx, ctx, macro_name)?;
        }
        return Ok(());
      }
      let (line, character) = get_location(&file_ctx.source_map, call.span.lo);
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
    Expr::TsAs(ts_as) => validate_node(&ts_as.expr, param_name, file_ctx, ctx, macro_name),
    Expr::TsSatisfies(ts_sat) => validate_node(&ts_sat.expr, param_name, file_ctx, ctx, macro_name),
    Expr::TsNonNull(ts_nn) => validate_node(&ts_nn.expr, param_name, file_ctx, ctx, macro_name),
    _ => Ok(()),
  }
}

fn is_enum_member_access(member: &MemberExpr, ctx: &EvalContext) -> bool {
  let obj_ident = match &*member.obj {
    Expr::Ident(ident) => ident.sym.as_str(),
    _ => return false,
  };
  let prop_name = match &member.prop {
    MemberProp::Ident(ident) => ident.sym.as_str().to_string(),
    _ => return false,
  };
  let full_name = format!("{}.{}", obj_ident, prop_name);
  ctx
    .enum_map
    .values()
    .any(|file_enums| file_enums.contains_key(&full_name))
}

fn is_param_chain(expr: &Expr, param_name: &str) -> bool {
  match expr {
    Expr::Ident(ident) => ident.sym.as_str() == param_name,
    Expr::Member(member) => is_param_chain(&member.obj, param_name),
    _ => false,
  }
}
