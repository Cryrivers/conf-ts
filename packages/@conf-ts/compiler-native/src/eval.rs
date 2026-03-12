use std::collections::{HashMap, HashSet};

use swc_common::{BytePos, SourceMap, Spanned};
use swc_ecma_ast::*;

use crate::error::ConfTSError;
use crate::macro_eval::evaluate_macro;
use crate::types::{CompileOptions, FileContext, Value};

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
    Expr::Lit(Lit::Num(n)) => Ok(Value::Number(n.value)),

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
              let val = resolve_identifier(&name, file_ctx, ctx, local_context, options)?;
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
      resolve_identifier(name, file_ctx, ctx, local_context, options)
    }

    // Property access: obj.prop
    Expr::Member(member) => eval_member_expr(member, file_ctx, ctx, local_context, options),

    // Unary prefix: +, -, !, ~
    Expr::Unary(unary) => {
      let operand = evaluate(&unary.arg, file_ctx, ctx, local_context, options)?;
      match unary.op {
        UnaryOp::Plus => Ok(Value::Number(operand.to_number())),
        UnaryOp::Minus => Ok(Value::Number(-operand.to_number())),
        UnaryOp::Bang => Ok(Value::Bool(!operand.is_truthy())),
        UnaryOp::Tilde => {
          let n = operand.to_number() as i32;
          Ok(Value::Number((!n) as f64))
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

    // Binary expressions
    Expr::Bin(bin) => {
      let left = evaluate(&bin.left, file_ctx, ctx, local_context, options)?;
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
      match &val {
        Value::Null | Value::Undefined => {
          let (line, character) = get_location(&file_ctx.source_map, ts_non_null.span.lo);
          Err(ConfTSError::new(
            "Non-null assertion failed: value is null or undefined",
            &file_ctx.file_path,
            line,
            character,
          ))
        }
        _ => Ok(val),
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

  // First, try to evaluate as object property access
  if let Ok(obj) = evaluate(&member.obj, file_ctx, ctx, local_context, options) {
    if let Value::Object(ref map) = obj {
      for (k, v) in map {
        if k == &prop_name {
          return Ok(v.clone());
        }
      }
    }
  }

  // Then try as enum access
  let full_name = if let Expr::Ident(ident) = member.obj.as_ref() {
    format!("{}.{}", ident_name(ident), prop_name)
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

  let (line, character) = get_location(&file_ctx.source_map, member.span.lo);
  Err(ConfTSError::new(
    format!(
      "Unsupported property access expression: {}.{}",
      expr_to_string(&member.obj),
      prop_name
    ),
    &file_ctx.file_path,
    line,
    character,
  ))
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
      _ => Ok(Value::Number(left.to_number() + right.to_number())),
    },
    BinaryOp::Sub => Ok(Value::Number(left.to_number() - right.to_number())),
    BinaryOp::Mul => Ok(Value::Number(left.to_number() * right.to_number())),
    BinaryOp::Div => Ok(Value::Number(left.to_number() / right.to_number())),
    BinaryOp::Mod => Ok(Value::Number(left.to_number() % right.to_number())),
    BinaryOp::Gt => Ok(Value::Bool(left.to_number() > right.to_number())),
    BinaryOp::Lt => Ok(Value::Bool(left.to_number() < right.to_number())),
    BinaryOp::GtEq => Ok(Value::Bool(left.to_number() >= right.to_number())),
    BinaryOp::LtEq => Ok(Value::Bool(left.to_number() <= right.to_number())),
    BinaryOp::EqEq => Ok(Value::Bool(left.loose_eq(&right))),
    BinaryOp::EqEqEq => Ok(Value::Bool(left.strict_eq(&right))),
    BinaryOp::NotEq => Ok(Value::Bool(!left.loose_eq(&right))),
    BinaryOp::NotEqEq => Ok(Value::Bool(!left.strict_eq(&right))),
    BinaryOp::LogicalAnd => {
      if left.is_truthy() {
        Ok(right)
      } else {
        Ok(left)
      }
    }
    BinaryOp::LogicalOr => {
      if left.is_truthy() {
        Ok(left)
      } else {
        Ok(right)
      }
    }
    BinaryOp::NullishCoalescing => match left {
      Value::Null | Value::Undefined => Ok(right),
      _ => Ok(left),
    },
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
) -> Result<Value, ConfTSError> {
  // Check in current file's declarations
  if let Some(val) = resolve_in_file(name, file_ctx, ctx, local_context, options)? {
    return Ok(val);
  }

  // Check imports
  if let Some(import_info) = file_ctx.imports.get(name) {
    let resolved_path = if let Some(ref resolver) = ctx.resolver {
      resolver(&import_info.source, &file_ctx.file_path)
    } else {
      None
    };

    if let Some(resolved_path) = resolved_path {
      if let Some(imported_ctx) = ctx.file_contexts.get(&resolved_path).cloned() {
        let original_name = import_info.original_name.as_deref().unwrap_or(name);
        if let Some(val) = resolve_in_file(original_name, &imported_ctx, ctx, None, options)? {
          return Ok(val);
        }
      }
    }
  }

  // Check enum map
  for (file_path, file_enums) in &ctx.enum_map {
    for (enum_key, val) in file_enums {
      if enum_key.ends_with(&format!(".{}", name)) {
        ctx.evaluated_files.insert(file_path.clone());
        return Ok(val.clone());
      }
    }
  }

  Err(ConfTSError::new(
    format!("Unsupported variable type for identifier: {}", name),
    &file_ctx.file_path,
    1,
    1,
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
