use std::collections::{HashMap, HashSet};

use swc_common::{BytePos, SourceMap, Spanned};
use swc_ecma_ast::*;

use crate::error::ConfTSError;
use crate::macro_eval::evaluate_macro;
use crate::types::{CompileOptions, FileContext, Value, normalize_number_raw};

const MACRO_FUNCTIONS: &[&str] = &[
  "String",
  "Number",
  "Boolean",
  "arrayMap",
  "arrayFilter",
  "env",
];

/// Get source location from a byte position.
pub fn get_location(sm: &SourceMap, pos: BytePos) -> (usize, usize) {
  let loc = sm.lookup_char_pos(pos);
  (loc.line, loc.col_display + 1)
}

/// Helper to get identifier name as &str
fn ident_name(ident: &Ident) -> &str {
  ident.sym.as_str()
}

/// Evaluate an expression node to a Value.
pub fn evaluate(
  expr: &Expr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  ctx.evaluated_files.insert(file_ctx.file_path.clone());

  // Ensure macro imports are populated for this file
  if options.macro_mode && !ctx.macro_imports_map.contains_key(&file_ctx.file_path) {
    let imports = collect_macro_imports(&file_ctx.module, &file_ctx.file_path);
    ctx
      .macro_imports_map
      .insert(file_ctx.file_path.clone(), imports);
  }

  match expr {
    // String literals
    Expr::Lit(Lit::Str(s)) => Ok(Value::String(s.value.as_str().unwrap_or("").to_string())),

    // Numeric literals
    Expr::Lit(Lit::Num(n)) => {
      let raw = n.raw.as_ref().map(|value| value.as_str().to_string());
      Ok(Value::number_with_raw(n.value, normalize_number_raw(raw)))
    }

    // Boolean literals
    Expr::Lit(Lit::Bool(b)) => Ok(Value::Bool(b.value)),

    // Null literal
    Expr::Lit(Lit::Null(_)) => Ok(Value::Null),

    // Template literals with expressions
    Expr::Tpl(tpl) => {
      let mut result = String::new();
      for i in 0..tpl.quasis.len() {
        if let Some(ref cooked) = tpl.quasis[i].cooked {
          result.push_str(cooked.as_str().unwrap_or(""));
        } else {
          result.push_str(tpl.quasis[i].raw.as_str());
        }
        if i < tpl.exprs.len() {
          let val = evaluate(&tpl.exprs[i], file_ctx, ctx, local_context, options)?;
          result.push_str(&val.to_display_string());
        }
      }
      Ok(Value::String(result))
    }

    // Object literal
    Expr::Object(obj) => {
      let mut map: Vec<(String, Value)> = Vec::new();
      for prop_or_spread in &obj.props {
        match prop_or_spread {
          PropOrSpread::Prop(prop) => match prop.as_ref() {
            Prop::KeyValue(kv) => {
              let key = eval_prop_name(&kv.key, file_ctx, ctx, local_context, options)?;
              let val = evaluate(&kv.value, file_ctx, ctx, local_context, options)?;
              map.retain(|(k, _)| k != &key);
              map.push((key, val));
            }
            Prop::Shorthand(ident) => {
              let name = ident_name(ident).to_string();
              if let Some(lc) = local_context {
                if let Some(val) = lc.get(&name) {
                  map.retain(|(k, _)| k != &name);
                  map.push((name, val.clone()));
                  continue;
                }
              }
              let (line, character) = get_location(&file_ctx.source_map, ident.span.lo);
              let val = resolve_identifier(
                &name,
                file_ctx,
                ctx,
                local_context,
                options,
                line,
                character,
              )?;
              map.retain(|(k, _)| k != &name);
              map.push((name, val));
            }
            _ => {
              let (line, character) = get_location(&file_ctx.source_map, prop.span().lo);
              return Err(ConfTSError::new(
                "Unsupported property type in object literal",
                &file_ctx.file_path,
                line,
                character,
              ));
            }
          },
          PropOrSpread::Spread(spread) => {
            let val = evaluate(&spread.expr, file_ctx, ctx, local_context, options)?;
            if let Value::Object(spread_map) = val {
              for (k, v) in spread_map {
                map.retain(|(key, _)| key != &k);
                map.push((k, v));
              }
            }
          }
        }
      }
      Ok(Value::Object(map))
    }

    // Array literal
    Expr::Array(arr) => {
      let mut elements = Vec::new();
      for elem in &arr.elems {
        match elem {
          Some(ExprOrSpread {
            spread: Some(_),
            expr,
          }) => {
            let val = evaluate(expr, file_ctx, ctx, local_context, options)?;
            if let Value::Array(items) = val {
              elements.extend(items);
            }
          }
          Some(ExprOrSpread { spread: None, expr }) => {
            let val = evaluate(expr, file_ctx, ctx, local_context, options)?;
            elements.push(val);
          }
          None => {
            elements.push(Value::Null);
          }
        }
      }
      Ok(Value::Array(elements))
    }

    // Identifiers
    Expr::Ident(ident) => {
      let name = ident_name(ident);
      if name == "undefined" {
        return Ok(Value::Undefined);
      }
      if let Some(lc) = local_context {
        if let Some(val) = lc.get(name) {
          return Ok(val.clone());
        }
      }
      let (line, character) = get_location(&file_ctx.source_map, ident.span.lo);
      resolve_identifier(name, file_ctx, ctx, local_context, options, line, character)
    }

    // Property access: obj.prop
    Expr::Member(member) => eval_member_expr(member, file_ctx, ctx, local_context, options),

    Expr::OptChain(opt_chain) => {
      eval_opt_chain_expr(opt_chain, file_ctx, ctx, local_context, options)
    }

    // Unary prefix: +, -, !, ~, typeof
    Expr::Unary(unary) => {
      // typeof does not throw on undefined identifiers in JS; mirror that
      // by catching resolve errors and returning "undefined".
      if matches!(unary.op, UnaryOp::TypeOf) {
        let operand = match evaluate(&unary.arg, file_ctx, ctx, local_context, options) {
          Ok(val) => val,
          Err(_) => Value::Undefined,
        };
        return Ok(Value::String(operand.typeof_string().to_string()));
      }
      let operand = evaluate(&unary.arg, file_ctx, ctx, local_context, options)?;
      match unary.op {
        UnaryOp::Plus => Ok(Value::number(operand.to_number())),
        UnaryOp::Minus => Ok(Value::number(-operand.to_number())),
        UnaryOp::Bang => Ok(Value::Bool(!operand.is_truthy())),
        UnaryOp::Tilde => {
          let n = operand.to_number() as i32;
          Ok(Value::number((!n) as f64))
        }
        _ => {
          let (line, character) = get_location(&file_ctx.source_map, unary.span.lo);
          Err(ConfTSError::new(
            format!("Unsupported unary operator: {:?}", unary.op),
            &file_ctx.file_path,
            line,
            character,
          ))
        }
      }
    }

    // Binary expressions (with short-circuit evaluation for logical ops)
    Expr::Bin(bin) => {
      let left = evaluate(&bin.left, file_ctx, ctx, local_context, options)?;
      match bin.op {
        BinaryOp::LogicalAnd => {
          if left.is_truthy() {
            evaluate(&bin.right, file_ctx, ctx, local_context, options)
          } else {
            Ok(left)
          }
        }
        BinaryOp::LogicalOr => {
          if left.is_truthy() {
            Ok(left)
          } else {
            evaluate(&bin.right, file_ctx, ctx, local_context, options)
          }
        }
        BinaryOp::NullishCoalescing => match left {
          Value::Null | Value::Undefined => {
            evaluate(&bin.right, file_ctx, ctx, local_context, options)
          }
          _ => Ok(left),
        },
        _ => {
          let right = evaluate(&bin.right, file_ctx, ctx, local_context, options)?;
          eval_binary_op(
            bin.op,
            left,
            right,
            &file_ctx.file_path,
            &file_ctx.source_map,
            bin.span.lo,
          )
        }
      }
    }

    // Parenthesized expressions
    Expr::Paren(paren) => evaluate(&paren.expr, file_ctx, ctx, local_context, options),

    // Type assertion (as)
    Expr::TsAs(ts_as) => evaluate(&ts_as.expr, file_ctx, ctx, local_context, options),

    // Const assertion (as const)
    Expr::TsConstAssertion(assert) => evaluate(&assert.expr, file_ctx, ctx, local_context, options),

    // Satisfies expression
    Expr::TsSatisfies(ts_satisfies) => {
      evaluate(&ts_satisfies.expr, file_ctx, ctx, local_context, options)
    }

    // Non-null assertion (!)
    Expr::TsNonNull(ts_non_null) => {
      let val = evaluate(&ts_non_null.expr, file_ctx, ctx, local_context, options)?;
      let (line, character) = get_location(&file_ctx.source_map, ts_non_null.span.lo);
      let is_typed_nullish = is_strictly_nullish_expr(&ts_non_null.expr, file_ctx);

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

    // Type assertion (angle bracket)
    Expr::TsTypeAssertion(assertion) => {
      evaluate(&assertion.expr, file_ctx, ctx, local_context, options)
    }

    // Conditional (ternary)
    Expr::Cond(cond) => {
      let condition = evaluate(&cond.test, file_ctx, ctx, local_context, options)?;
      if condition.is_truthy() {
        evaluate(&cond.cons, file_ctx, ctx, local_context, options)
      } else {
        evaluate(&cond.alt, file_ctx, ctx, local_context, options)
      }
    }

    // Arrow function / function expression => error
    Expr::Arrow(_) | Expr::Fn(_) => {
      let (line, character) = get_location(&file_ctx.source_map, expr.span().lo);
      Err(ConfTSError::new(
        "Unsupported type: Function",
        &file_ctx.file_path,
        line,
        character,
      ))
    }

    // new expression
    Expr::New(new_expr) => {
      let callee_name = expr_to_string(&new_expr.callee);
      let (line, character) = get_location(&file_ctx.source_map, new_expr.span.lo);
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

    // Call expression
    Expr::Call(call) => {
      if options.macro_mode {
        return evaluate_macro(call, file_ctx, ctx, local_context, options);
      }
      let callee = call_expr_callee_name(call);
      let (line, character) = get_location(&file_ctx.source_map, call.span.lo);
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

    // Regular expression literal
    Expr::Lit(Lit::Regex(_)) => {
      let (line, character) = get_location(&file_ctx.source_map, expr.span().lo);
      Err(ConfTSError::new(
        "Unsupported type: RegExp",
        &file_ctx.file_path,
        line,
        character,
      ))
    }

    // Sequence expression
    Expr::Seq(seq) => {
      let mut result = Value::Undefined;
      for e in &seq.exprs {
        result = evaluate(e, file_ctx, ctx, local_context, options)?;
      }
      Ok(result)
    }

    _ => {
      let (line, character) = get_location(&file_ctx.source_map, expr.span().lo);
      Err(ConfTSError::new(
        format!("Unsupported syntax kind: {:?}", expr),
        &file_ctx.file_path,
        line,
        character,
      ))
    }
  }
}

/// Evaluate a member expression (property access).
fn eval_member_expr(
  member: &MemberExpr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let prop_name = match &member.prop {
    MemberProp::Ident(ident_name_node) => ident_name_node.sym.as_str().to_string(),
    MemberProp::Computed(comp) => {
      let val = evaluate(&comp.expr, file_ctx, ctx, local_context, options)?;
      val.to_display_string()
    }
    _ => {
      let (line, character) = get_location(&file_ctx.source_map, member.span.lo);
      return Err(ConfTSError::new(
        "Unsupported member expression property type",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  let mut obj_debug = String::new();
  let obj_eval = evaluate(&member.obj, file_ctx, ctx, local_context, options);
  if let Ok(obj) = obj_eval {
    obj_debug = match &obj {
      Value::Object(map) => {
        let mut keys: Vec<String> = map.iter().map(|(k, _)| k.clone()).collect();
        keys.sort();
        if keys.is_empty() {
          "object keys=[]".to_string()
        } else {
          format!("object keys=[{}]", keys.join(", "))
        }
      }
      Value::Array(arr) => format!("array length={}", arr.len()),
      _ => format!("value={}", obj.to_display_string()),
    };
    match &obj {
      Value::Object(map) => {
        for (k, v) in map {
          if k == &prop_name {
            return Ok(v.clone());
          }
        }
      }
      Value::Array(arr) => {
        if matches!(member.prop, MemberProp::Computed(_)) {
          if let Ok(idx) = prop_name.parse::<usize>() {
            return Ok(arr.get(idx).cloned().unwrap_or(Value::Undefined));
          }
          return Ok(Value::Undefined);
        }
      }
      Value::String(s) => {
        if matches!(member.prop, MemberProp::Computed(_)) {
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
      }
      _ => {}
    }
  } else if let Err(err) = obj_eval {
    obj_debug = format!("eval_error={}", err.message);
  }

  // Then try as enum access
  let full_name = if let Expr::Ident(ident) = member.obj.as_ref() {
    format!("{}.{}", ident_name(ident), prop_name)
  } else {
    String::new()
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

  let (line, character) = get_location(&file_ctx.source_map, member.span.lo);
  Err(ConfTSError::new(
    format!(
      "Unsupported property access expression: {}.{}. Debug: obj={}, enum_lookup={}, enum_candidates={}/{}",
      expr_to_string(&member.obj),
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

fn eval_opt_chain_expr(
  opt_chain: &OptChainExpr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  match &*opt_chain.base {
    OptChainBase::Member(member) => {
      eval_optional_member_expr(member, file_ctx, ctx, local_context, options)
    }
    OptChainBase::Call(call) => {
      match evaluate(&call.callee, file_ctx, ctx, local_context, options) {
        Ok(Value::Null) | Ok(Value::Undefined) => Ok(Value::Undefined),
        _ => {
          let wrapped = Expr::Call(CallExpr {
            span: call.span,
            ctxt: call.ctxt,
            callee: Callee::Expr(call.callee.clone()),
            args: call.args.clone(),
            type_args: call.type_args.clone(),
          });
          evaluate(&wrapped, file_ctx, ctx, local_context, options)
        }
      }
    }
  }
}

fn eval_optional_member_expr(
  member: &MemberExpr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let prop_name = match &member.prop {
    MemberProp::Ident(ident_name_node) => ident_name_node.sym.as_str().to_string(),
    MemberProp::Computed(comp) => {
      let val = evaluate(&comp.expr, file_ctx, ctx, local_context, options)?;
      val.to_display_string()
    }
    _ => {
      let (line, character) = get_location(&file_ctx.source_map, member.span.lo);
      return Err(ConfTSError::new(
        "Unsupported member expression property type",
        &file_ctx.file_path,
        line,
        character,
      ));
    }
  };

  let obj = evaluate(&member.obj, file_ctx, ctx, local_context, options)?;
  match obj {
    Value::Null | Value::Undefined => Ok(Value::Undefined),
    Value::Object(map) => {
      for (k, v) in map {
        if k == prop_name {
          return Ok(v);
        }
      }
      Ok(Value::Undefined)
    }
    Value::Array(arr) => {
      if matches!(member.prop, MemberProp::Computed(_)) {
        if let Ok(idx) = prop_name.parse::<usize>() {
          return Ok(arr.get(idx).cloned().unwrap_or(Value::Undefined));
        }
      }
      Ok(Value::Undefined)
    }
    _ => Ok(Value::Undefined),
  }
}

/// Evaluate a binary operation.
fn eval_binary_op(
  op: BinaryOp,
  left: Value,
  right: Value,
  file: &str,
  sm: &SourceMap,
  pos: BytePos,
) -> Result<Value, ConfTSError> {
  match op {
    BinaryOp::Add => match (&left, &right) {
      (Value::String(l), _) => Ok(Value::String(format!("{}{}", l, right.to_display_string()))),
      (_, Value::String(r)) => Ok(Value::String(format!("{}{}", left.to_display_string(), r))),
      _ => Ok(Value::number(left.to_number() + right.to_number())),
    },
    BinaryOp::Sub => Ok(Value::number(left.to_number() - right.to_number())),
    BinaryOp::Mul => Ok(Value::number(left.to_number() * right.to_number())),
    BinaryOp::Div => Ok(Value::number(left.to_number() / right.to_number())),
    BinaryOp::Mod => Ok(Value::number(left.to_number() % right.to_number())),
    BinaryOp::Exp => Ok(Value::number(left.to_number().powf(right.to_number()))),
    BinaryOp::Gt => Ok(Value::Bool(left.to_number() > right.to_number())),
    BinaryOp::Lt => Ok(Value::Bool(left.to_number() < right.to_number())),
    BinaryOp::GtEq => Ok(Value::Bool(left.to_number() >= right.to_number())),
    BinaryOp::LtEq => Ok(Value::Bool(left.to_number() <= right.to_number())),
    BinaryOp::EqEq => Ok(Value::Bool(left.loose_eq(&right))),
    BinaryOp::EqEqEq => Ok(Value::Bool(left.strict_eq(&right))),
    BinaryOp::NotEq => Ok(Value::Bool(!left.loose_eq(&right))),
    BinaryOp::NotEqEq => Ok(Value::Bool(!left.strict_eq(&right))),
    BinaryOp::BitAnd => Ok(Value::number(
      ((left.to_number() as i32) & (right.to_number() as i32)) as f64,
    )),
    BinaryOp::BitOr => Ok(Value::number(
      ((left.to_number() as i32) | (right.to_number() as i32)) as f64,
    )),
    BinaryOp::BitXor => Ok(Value::number(
      ((left.to_number() as i32) ^ (right.to_number() as i32)) as f64,
    )),
    BinaryOp::LShift => Ok(Value::number(
      ((left.to_number() as i32) << ((right.to_number() as i32) & 31)) as f64,
    )),
    BinaryOp::RShift => Ok(Value::number(
      ((left.to_number() as i32) >> ((right.to_number() as i32) & 31)) as f64,
    )),
    BinaryOp::ZeroFillRShift => Ok(Value::number(
      ((left.to_number() as i32 as u32) >> ((right.to_number() as i32) & 31)) as f64,
    )),
    BinaryOp::In => {
      let key = left.to_display_string();
      match &right {
        Value::Object(map) => Ok(Value::Bool(map.iter().any(|(k, _)| k == &key))),
        Value::Array(arr) => match key.parse::<usize>() {
          Ok(idx) => Ok(Value::Bool(idx < arr.len())),
          Err(_) => Ok(Value::Bool(false)),
        },
        _ => {
          let (line, character) = get_location(sm, pos);
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
      let (line, character) = get_location(sm, pos);
      Err(ConfTSError::new(
        format!("Unsupported binary operator: {:?}", op),
        file,
        line,
        character,
      ))
    }
  }
}

/// Evaluate a property name (key in object literal).
fn eval_prop_name(
  prop: &PropName,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<String, ConfTSError> {
  match prop {
    PropName::Ident(id) => Ok(id.sym.as_str().to_string()),
    PropName::Str(s) => Ok(s.value.as_str().unwrap_or("").to_string()),
    PropName::Num(n) => Ok(n.value.to_string()),
    PropName::Computed(comp) => {
      let val = evaluate(&comp.expr, file_ctx, ctx, local_context, options)?;
      Ok(val.to_display_string())
    }
    PropName::BigInt(bi) => Ok(bi.value.to_string()),
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
  // Check in current file's declarations
  if let Some(val) = resolve_in_file(name, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }

  // Check imports
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
        if let Some(val) = resolve_in_file(original_name, &imported_ctx, ctx, None, options)? {
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

  // Check enum map
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

/// Try to resolve a name within a file's declarations.
fn resolve_in_file(
  name: &str,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if name == "default" {
    for item in &file_ctx.module.body {
      if let ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(export)) = item {
        let val = evaluate(&export.expr, file_ctx, ctx, local_context, options)?;
        return Ok(Some(val));
      }
      if let ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_)) = item {
        let (line, character) = get_location(&file_ctx.source_map, item.span().lo);
        return Err(ConfTSError::new(
          "Unsupported default export declaration",
          &file_ctx.file_path,
          line,
          character,
        ));
      }
    }
  }
  for item in &file_ctx.module.body {
    match item {
      ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
        if let Some(result) = check_var_decl(name, var_decl, file_ctx, ctx, local_context, options)?
        {
          return Ok(Some(result));
        }
      }
      ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
        if let Decl::Var(var_decl) = &export_decl.decl {
          if let Some(result) =
            check_var_decl(name, var_decl, file_ctx, ctx, local_context, options)?
          {
            return Ok(Some(result));
          }
        }
      }
      _ => {}
    }
  }
  Ok(None)
}

fn check_var_decl(
  name: &str,
  var_decl: &VarDecl,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if var_decl.kind != VarDeclKind::Const {
    for decl in &var_decl.decls {
      if let Pat::Ident(ident) = &decl.name {
        if ident_name(&ident.id) == name {
          let kind = match var_decl.kind {
            VarDeclKind::Let => "let",
            VarDeclKind::Var => "var",
            _ => "const",
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
  for decl in &var_decl.decls {
    match &decl.name {
      Pat::Ident(ident) if ident_name(&ident.id) == name => {
        if let Some(ref init) = decl.init {
          let val = evaluate(init, file_ctx, ctx, local_context, options)?;
          return Ok(Some(val));
        }
      }
      Pat::Object(obj_pat) => {
        if let Some(ref init) = decl.init {
          if let Some(val) =
            resolve_destructured(name, obj_pat, init, file_ctx, ctx, local_context, options)?
          {
            return Ok(Some(val));
          }
        }
      }
      Pat::Array(arr_pat) => {
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

/// Resolve a name from an array destructuring pattern.
fn resolve_array_destructured(
  name: &str,
  arr_pat: &ArrayPat,
  init: &Expr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  for (idx, elem) in arr_pat.elems.iter().enumerate() {
    let Some(pat) = elem else {
      continue;
    };
    match pat {
      Pat::Ident(bind_ident) => {
        if ident_name(&bind_ident.id) == name {
          let source = evaluate(init, file_ctx, ctx, local_context, options)?;
          if let Value::Array(items) = source {
            return Ok(Some(items.get(idx).cloned().unwrap_or(Value::Undefined)));
          }
          return Ok(Some(Value::Undefined));
        }
      }
      Pat::Rest(rest) => {
        if let Pat::Ident(rest_ident) = &*rest.arg {
          if ident_name(&rest_ident.id) == name {
            let source = evaluate(init, file_ctx, ctx, local_context, options)?;
            if let Value::Array(mut items) = source {
              return Ok(Some(Value::Array(if idx >= items.len() {
                Vec::new()
              } else {
                items.split_off(idx)
              })));
            }
            return Ok(Some(Value::Array(Vec::new())));
          }
        }
      }
      _ => {}
    }
  }
  Ok(None)
}

/// Resolve a name from a destructuring pattern.
fn resolve_destructured(
  name: &str,
  obj_pat: &ObjectPat,
  init: &Expr,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  for prop in &obj_pat.props {
    match prop {
      ObjectPatProp::KeyValue(kv) => {
        if let Pat::Ident(bind_ident) = &*kv.value {
          if ident_name(&bind_ident.id) == name {
            let source_obj = evaluate(init, file_ctx, ctx, local_context, options)?;
            let key = prop_name_to_string(&kv.key);
            if let Value::Object(map) = source_obj {
              for (k, v) in &map {
                if k == &key {
                  return Ok(Some(v.clone()));
                }
              }
            }
            return Ok(Some(Value::Undefined));
          }
        }
      }
      ObjectPatProp::Assign(assign) => {
        if ident_name(&assign.key) == name {
          let source_obj = evaluate(init, file_ctx, ctx, local_context, options)?;
          if let Value::Object(map) = source_obj {
            for (k, v) in &map {
              if k == name {
                return Ok(Some(v.clone()));
              }
            }
          }
          return Ok(Some(Value::Undefined));
        }
      }
      ObjectPatProp::Rest(rest) => {
        if let Pat::Ident(rest_ident) = &*rest.arg {
          if ident_name(&rest_ident.id) == name {
            let source_obj = evaluate(init, file_ctx, ctx, local_context, options)?;
            let mut keys_to_remove = HashSet::new();
            for p in &obj_pat.props {
              match p {
                ObjectPatProp::KeyValue(kv) => {
                  keys_to_remove.insert(prop_name_to_string(&kv.key));
                }
                ObjectPatProp::Assign(assign) => {
                  keys_to_remove.insert(ident_name(&assign.key).to_string());
                }
                ObjectPatProp::Rest(_) => {}
              }
            }
            if let Value::Object(map) = source_obj {
              let rest_obj: Vec<(String, Value)> = map
                .into_iter()
                .filter(|(k, _)| !keys_to_remove.contains(k))
                .collect();
              return Ok(Some(Value::Object(rest_obj)));
            }
            return Ok(Some(Value::Object(Vec::new())));
          }
        }
      }
    }
  }
  Ok(None)
}

fn prop_name_to_string(prop: &PropName) -> String {
  match prop {
    PropName::Ident(id) => id.sym.as_str().to_string(),
    PropName::Str(s) => s.value.as_str().unwrap_or("").to_string(),
    PropName::Num(n) => n.value.to_string(),
    PropName::BigInt(bi) => bi.value.to_string(),
    PropName::Computed(_) => String::new(),
  }
}

/// Convert an expression to a display string (for error messages).
pub fn expr_to_string(expr: &Expr) -> String {
  match expr {
    Expr::Ident(ident) => ident_name(ident).to_string(),
    Expr::Member(member) => {
      let obj = expr_to_string(&member.obj);
      match &member.prop {
        MemberProp::Ident(id) => format!("{}.{}", obj, id.sym.as_str()),
        _ => format!("{}[...]", obj),
      }
    }
    _ => "<expression>".to_string(),
  }
}

/// Get the callee name from a call expression.
pub fn call_expr_callee_name(call: &CallExpr) -> String {
  match &call.callee {
    Callee::Expr(expr) => expr_to_string(expr),
    _ => "<unknown>".to_string(),
  }
}

/// Collect macro imports from a module's import declarations.
pub fn collect_macro_imports(module: &Module, _file_path: &str) -> HashSet<String> {
  let mut imports = HashSet::new();
  for item in &module.body {
    if let ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl)) = item {
      let module_specifier = import_decl.src.value.as_str().unwrap_or("");
      if module_specifier == "@conf-ts/macro" {
        for specifier in &import_decl.specifiers {
          if let ImportSpecifier::Named(named) = specifier {
            imports.insert(ident_name(&named.local).to_string());
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

/// Collect all imports from a module.
pub fn collect_imports(module: &Module) -> HashMap<String, ImportInfo> {
  let mut imports = HashMap::new();
  for item in &module.body {
    if let ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl)) = item {
      let source = import_decl.src.value.as_str().unwrap_or("").to_string();
      for specifier in &import_decl.specifiers {
        match specifier {
          ImportSpecifier::Named(named) => {
            let local_name = ident_name(&named.local).to_string();
            let original_name = named.imported.as_ref().map(|imp| match imp {
              ModuleExportName::Ident(ident) => ident_name(ident).to_string(),
              ModuleExportName::Str(s) => s.value.as_str().unwrap_or("").to_string(),
            });
            imports.insert(
              local_name,
              ImportInfo {
                source: source.clone(),
                original_name,
              },
            );
          }
          ImportSpecifier::Default(default) => {
            imports.insert(
              ident_name(&default.local).to_string(),
              ImportInfo {
                source: source.clone(),
                original_name: Some("default".to_string()),
              },
            );
          }
          ImportSpecifier::Namespace(ns) => {
            imports.insert(
              ident_name(&ns.local).to_string(),
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

/// Check if an expression is strictly typed as null or undefined.
fn is_strictly_nullish_expr(expr: &Expr, file_ctx: &FileContext) -> bool {
  match expr {
    Expr::Lit(Lit::Null(_)) => true,
    Expr::Ident(ident) if ident.sym == "undefined" => true,
    Expr::Ident(ident) => {
      // Look for variable declaration in the current file
      for item in &file_ctx.module.body {
        match item {
          ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export_decl)) => {
            if let Decl::Var(var_decl) = &export_decl.decl {
              if let Some(type_ann) = find_type_ann_in_var_decl(&ident.sym, var_decl) {
                return is_nullish_type(type_ann);
              }
            }
          }
          ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
            if let Some(type_ann) = find_type_ann_in_var_decl(&ident.sym, var_decl) {
              return is_nullish_type(type_ann);
            }
          }
          _ => {}
        }
      }
      false
    }
    Expr::TsAs(ts_as) => is_nullish_type(&ts_as.type_ann),
    Expr::TsSatisfies(ts_sat) => is_nullish_type(&ts_sat.type_ann),
    Expr::Paren(paren) => is_strictly_nullish_expr(&paren.expr, file_ctx),
    _ => false,
  }
}

/// Find the type annotation for a variable in a declaration.
fn find_type_ann_in_var_decl<'a>(name: &str, var_decl: &'a VarDecl) -> Option<&'a TsType> {
  for decl in &var_decl.decls {
    if let Pat::Ident(binding_ident) = &decl.name {
      if binding_ident.id.sym == name {
        return binding_ident.type_ann.as_ref().map(|at| &*at.type_ann);
      }
    }
  }
  None
}

/// Check if a TypeScript type is strictly null or undefined (or a union of them).
fn is_nullish_type(t: &TsType) -> bool {
  match t {
    TsType::TsKeywordType(kt) => {
      kt.kind == TsKeywordTypeKind::TsNullKeyword
        || kt.kind == TsKeywordTypeKind::TsUndefinedKeyword
    }
    TsType::TsUnionOrIntersectionType(TsUnionOrIntersectionType::TsUnionType(ut)) => {
      ut.types.iter().all(|sub_t| is_nullish_type(sub_t))
    }
    TsType::TsParenthesizedType(pt) => is_nullish_type(&pt.type_ann),
    _ => false,
  }
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
