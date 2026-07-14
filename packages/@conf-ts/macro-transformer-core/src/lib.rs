use std::any::Any;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use compiler_native::browser::ProjectResolutions;
use compiler_native::compiler::parse_ts_file;
use compiler_native::error::ConfTSError;
use compiler_native::eval::{
  EvalContext, call_expr_callee_name, collect_imports, evaluate, get_location,
};
use compiler_native::resolver::{TsCompilerOptions, resolve_module_in_memory_with_options};
use compiler_native::types::{CompileOptions, FileContext, Value};
use serde::{Deserialize, Serialize};
use swc_core::common::{GLOBALS, Globals, Mark, SourceMap, Spanned, sync::Lrc};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{Config as CodegenConfig, Emitter, Node, text_writer::JsWriter};
use swc_core::ecma::transforms::base::resolver;
use swc_core::ecma::visit::{Visit, VisitMut, VisitMutWith, VisitWith};

const MACRO_MODULE: &str = "@conf-ts/macro";
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
const EXPR_CALLBACK_ERROR: &str =
  "expr callback must be an arrow function with a single identifier parameter and expression body";

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QuoteStyle {
  Single,
  #[default]
  Double,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TransformOptions {
  pub env: HashMap<String, String>,
  pub quote: QuoteStyle,
  pub preserve_key_order: bool,
  pub source_map: bool,
  #[serde(skip)]
  pub inherit_process_env: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectSnapshot {
  pub files: HashMap<String, String>,
  pub resolutions: ProjectResolutions,
  pub compiler_options: Option<serde_json::Value>,
  pub entry_files: Vec<String>,
  pub dependencies: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TransformInput {
  pub filename: String,
  pub code: String,
  pub project: Option<ProjectSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformOutput {
  pub code: String,
  pub map: Option<serde_json::Value>,
  pub dependencies: Vec<String>,
}

#[derive(Debug, Clone)]
struct Replacement {
  start: usize,
  end: usize,
  source: String,
}

#[derive(Debug, Default)]
struct TransformState {
  imports: HashMap<String, MacroBindings>,
  options: TransformOptions,
  depth: usize,
  replacements: HashMap<String, Vec<Replacement>>,
}

#[derive(Debug, Clone, Default)]
struct MacroBindings {
  named: HashMap<Id, String>,
  namespaces: HashSet<Id>,
}

type SharedState = Rc<RefCell<TransformState>>;

fn state(eval_ctx: &EvalContext) -> SharedState {
  eval_ctx
    .extension
    .as_ref()
    .and_then(|value| value.clone().downcast::<RefCell<TransformState>>().ok())
    .expect("macro transform state is installed")
}

fn compile_options(options: &TransformOptions) -> CompileOptions {
  CompileOptions {
    preserve_key_order: options.preserve_key_order,
  }
}

fn macro_imports(module: &Module) -> MacroBindings {
  let mut imports = MacroBindings::default();
  for item in &module.body {
    let ModuleItem::ModuleDecl(ModuleDecl::Import(declaration)) = item else {
      continue;
    };
    if declaration.src.value.as_str() != Some(MACRO_MODULE) {
      continue;
    }
    for specifier in &declaration.specifiers {
      if let ImportSpecifier::Named(specifier) = specifier {
        let canonical = specifier
          .imported
          .as_ref()
          .map(export_name)
          .unwrap_or_else(|| specifier.local.sym.as_str().to_string());
        if !declaration.type_only
          && !specifier.is_type_only
          && MACRO_FUNCTIONS.contains(&canonical.as_str())
        {
          imports.named.insert(specifier.local.to_id(), canonical);
        }
      } else if let ImportSpecifier::Namespace(specifier) = specifier
        && !declaration.type_only
      {
        imports.namespaces.insert(specifier.local.to_id());
      }
    }
  }
  imports
}

fn export_name(value: &ModuleExportName) -> String {
  match value {
    ModuleExportName::Ident(value) => value.sym.as_str().to_string(),
    ModuleExportName::Str(value) => value.value.as_str().unwrap_or("").to_string(),
  }
}

fn build_contexts(
  files: &HashMap<String, String>,
) -> Result<(HashMap<String, FileContext>, Lrc<SourceMap>), ConfTSError> {
  let source_map: Lrc<SourceMap> = Lrc::new(SourceMap::default());
  let mut contexts = HashMap::new();
  for (filename, source) in files {
    if !matches!(
      filename.rsplit('.').next(),
      Some("ts" | "js" | "mts" | "cts" | "mjs" | "cjs")
    ) {
      continue;
    }
    let mut module = parse_ts_file(source, filename, &source_map)?;
    GLOBALS.set(&Globals::new(), || {
      let unresolved_mark = Mark::new();
      let top_level_mark = Mark::new();
      module.visit_mut_with(&mut resolver(unresolved_mark, top_level_mark, true));
    });
    let start_pos = source_map.lookup_byte_offset(module.span.lo).sf.start_pos;
    contexts.insert(
      filename.clone(),
      FileContext {
        file_path: filename.clone(),
        source: source.clone(),
        start_pos,
        imports: collect_imports(&module),
        module,
        source_map: source_map.clone(),
      },
    );
  }
  Ok((contexts, source_map))
}

fn collect_enums(
  contexts: &HashMap<String, FileContext>,
  eval_ctx: &mut EvalContext,
  options: &CompileOptions,
) {
  for (filename, file_ctx) in contexts {
    for item in &file_ctx.module.body {
      let declaration = match item {
        ModuleItem::Stmt(Stmt::Decl(Decl::TsEnum(value))) => Some(value.as_ref()),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(value)) => match &value.decl {
          Decl::TsEnum(value) => Some(value.as_ref()),
          _ => None,
        },
        _ => None,
      };
      let Some(declaration) = declaration else {
        continue;
      };
      let mut next = 0_i64;
      let mut local = HashMap::new();
      for member in &declaration.members {
        let name = match &member.id {
          TsEnumMemberId::Ident(value) => value.sym.as_str().to_string(),
          TsEnumMemberId::Str(value) => value.value.as_str().unwrap_or("").to_string(),
        };
        let value = member
          .init
          .as_ref()
          .and_then(|value| evaluate(value, file_ctx, eval_ctx, Some(&local), options).ok())
          .unwrap_or_else(|| Value::number(next as f64));
        if let Value::Number(number) = &value {
          next = number.value as i64 + 1;
        } else {
          next += 1;
        }
        local.insert(name.clone(), value.clone());
        eval_ctx
          .enum_map
          .entry(filename.clone())
          .or_default()
          .insert(format!("{}.{}", declaration.id.sym, name), value);
      }
    }
  }
}

fn canonical_from_bindings(call: &CallExpr, bindings: &MacroBindings) -> Option<String> {
  let Callee::Expr(callee) = &call.callee else {
    return None;
  };
  match callee.as_ref() {
    Expr::Ident(identifier) => bindings.named.get(&identifier.to_id()).cloned(),
    Expr::Member(member) => {
      let Expr::Ident(namespace) = member.obj.as_ref() else {
        return None;
      };
      if !bindings.namespaces.contains(&namespace.to_id()) {
        return None;
      }
      let name = match &member.prop {
        MemberProp::Ident(value) => value.sym.as_str(),
        MemberProp::Computed(value) => match value.expr.as_ref() {
          Expr::Lit(Lit::Str(value)) => value.value.as_str().unwrap_or(""),
          _ => return None,
        },
        MemberProp::PrivateName(_) => return None,
      };
      MACRO_FUNCTIONS.contains(&name).then(|| name.to_string())
    }
    _ => None,
  }
}

fn canonical_callee(
  call: &CallExpr,
  file_ctx: &FileContext,
  eval_ctx: &EvalContext,
) -> Option<String> {
  state(eval_ctx)
    .borrow()
    .imports
    .get(&file_ctx.file_path)
    .and_then(|imports| canonical_from_bindings(call, imports))
}

fn argument<'a>(
  call: &'a CallExpr,
  index: usize,
  file_ctx: &FileContext,
  name: &str,
) -> Result<&'a Expr, ConfTSError> {
  let value = call.args.get(index).ok_or_else(|| {
    let (line, column) = get_location(&file_ctx.source_map, call.span.lo);
    ConfTSError::new(
      format!("Unsupported call expression in macro mode: {}", name),
      &file_ctx.file_path,
      line,
      column,
    )
  })?;
  if value.spread.is_some() {
    let (line, column) = get_location(&file_ctx.source_map, value.span().lo);
    return Err(ConfTSError::new(
      format!("{}: spread arguments are not supported", name),
      &file_ctx.file_path,
      line,
      column,
    ));
  }
  Ok(&value.expr)
}

fn callback<'a>(
  call: &'a CallExpr,
  file_ctx: &FileContext,
  name: &str,
) -> Result<(String, &'a Expr), ConfTSError> {
  let callback = argument(call, 1, file_ctx, name)?;
  let Expr::Arrow(callback) = callback else {
    let (line, column) = get_location(&file_ctx.source_map, callback.span().lo);
    return Err(ConfTSError::new(
      format!("{}: callback must be an arrow function", name),
      &file_ctx.file_path,
      line,
      column,
    ));
  };
  if callback.params.len() != 1 {
    let (line, column) = get_location(&file_ctx.source_map, callback.span.lo);
    return Err(ConfTSError::new(
      format!("{}: callback must have exactly one parameter", name),
      &file_ctx.file_path,
      line,
      column,
    ));
  }
  let Pat::Ident(parameter) = &callback.params[0] else {
    let (line, column) = get_location(&file_ctx.source_map, callback.params[0].span().lo);
    return Err(ConfTSError::new(
      format!("{}: callback parameter must be an identifier", name),
      &file_ctx.file_path,
      line,
      column,
    ));
  };
  let body = match callback.body.as_ref() {
    BlockStmtOrExpr::Expr(value) => value.as_ref(),
    BlockStmtOrExpr::BlockStmt(block) => {
      if block.stmts.len() == 1 {
        if let Stmt::Return(ReturnStmt {
          arg: Some(value), ..
        }) = &block.stmts[0]
        {
          value.as_ref()
        } else {
          let (line, column) = get_location(&file_ctx.source_map, block.span.lo);
          return Err(ConfTSError::new(
            format!("{}: callback body must be a single return statement", name),
            &file_ctx.file_path,
            line,
            column,
          ));
        }
      } else {
        let (line, column) = get_location(&file_ctx.source_map, block.span.lo);
        return Err(ConfTSError::new(
          format!("{}: callback body must be a single return statement", name),
          &file_ctx.file_path,
          line,
          column,
        ));
      }
    }
  };
  Ok((parameter.id.sym.as_str().to_string(), body))
}

fn evaluate_cast(
  name: &str,
  call: &CallExpr,
  file_ctx: &FileContext,
  eval_ctx: &mut EvalContext,
  local: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if !matches!(name, "String" | "Number" | "Boolean") || call.args.len() != 1 {
    return Ok(None);
  }
  let value = evaluate(
    argument(call, 0, file_ctx, name)?,
    file_ctx,
    eval_ctx,
    local,
    options,
  )?;
  Ok(Some(match name {
    "String" => Value::String(value.to_display_string()),
    "Number" => Value::number(value.to_number()),
    "Boolean" => Value::Bool(value.is_truthy()),
    _ => unreachable!(),
  }))
}

fn evaluate_env(
  name: &str,
  call: &CallExpr,
  file_ctx: &FileContext,
  eval_ctx: &mut EvalContext,
  local: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if name != "env" || !matches!(call.args.len(), 1 | 2) {
    return Ok(None);
  }
  let key = evaluate(
    argument(call, 0, file_ctx, name)?,
    file_ctx,
    eval_ctx,
    local,
    options,
  )?;
  let Value::String(key) = key else {
    let (line, column) = get_location(&file_ctx.source_map, call.args[0].span().lo);
    return Err(ConfTSError::new(
      "env macro argument must be a string",
      &file_ctx.file_path,
      line,
      column,
    ));
  };
  let default = if call.args.len() == 2 {
    let value = evaluate(
      argument(call, 1, file_ctx, name)?,
      file_ctx,
      eval_ctx,
      local,
      options,
    )?;
    match value {
      Value::String(_) | Value::Undefined => Some(value),
      _ => {
        let (line, column) = get_location(&file_ctx.source_map, call.args[1].span().lo);
        return Err(ConfTSError::new(
          "env macro default value must be a string",
          &file_ctx.file_path,
          line,
          column,
        ));
      }
    }
  } else {
    None
  };
  let shared = state(eval_ctx);
  let transform_options = shared.borrow().options.clone();
  if let Some(value) = transform_options.env.get(&key) {
    return Ok(Some(Value::String(value.clone())));
  }
  if transform_options.inherit_process_env
    && let Ok(value) = std::env::var(&key)
  {
    return Ok(Some(Value::String(value)));
  }
  Ok(Some(default.unwrap_or(Value::Undefined)))
}

fn evaluate_array_macro(
  name: &str,
  call: &CallExpr,
  file_ctx: &FileContext,
  eval_ctx: &mut EvalContext,
  local: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if !matches!(name, "arrayMap" | "arrayFlatMap" | "arrayFilter") || call.args.len() != 2 {
    return Ok(None);
  }
  let input = evaluate(
    argument(call, 0, file_ctx, name)?,
    file_ctx,
    eval_ctx,
    local,
    options,
  )?;
  let Value::Array(items) = input else {
    return Ok(Some(Value::Array(Vec::new())));
  };
  let (parameter, body) = callback(call, file_ctx, name)?;
  let mut output = Vec::new();
  for item in items {
    let mut callback_context = HashMap::new();
    callback_context.insert(parameter.clone(), item.clone());
    let value = evaluate(body, file_ctx, eval_ctx, Some(&callback_context), options)?;
    match name {
      "arrayMap" => output.push(value),
      "arrayFlatMap" => match value {
        Value::Array(values) => output.extend(values),
        value => output.push(value),
      },
      "arrayFilter" if value.is_truthy() => output.push(item),
      "arrayFilter" => {}
      _ => unreachable!(),
    }
  }
  Ok(Some(Value::Array(output)))
}

fn evaluate_macro(
  call: &CallExpr,
  file_ctx: &FileContext,
  eval_ctx: &mut EvalContext,
  local: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let name =
    canonical_callee(call, file_ctx, eval_ctx).unwrap_or_else(|| call_expr_callee_name(call));
  if let Some(value) = evaluate_expr(&name, call, file_ctx, eval_ctx, options)? {
    return Ok(value);
  }
  if let Some(value) = evaluate_cast(&name, call, file_ctx, eval_ctx, local, options)? {
    return Ok(value);
  }
  if let Some(value) = evaluate_env(&name, call, file_ctx, eval_ctx, local, options)? {
    return Ok(value);
  }
  if let Some(value) = evaluate_array_macro(&name, call, file_ctx, eval_ctx, local, options)? {
    return Ok(value);
  }
  let (line, column) = get_location(&file_ctx.source_map, call.span.lo);
  Err(ConfTSError::new(
    format!("Unsupported call expression in macro mode: {}", name),
    &file_ctx.file_path,
    line,
    column,
  ))
}

fn value_to_source(value: &Value) -> String {
  match value {
    Value::Undefined => "undefined".to_string(),
    Value::Null => "null".to_string(),
    Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
    Value::Bool(value) => value.to_string(),
    Value::Number(number) => {
      if let Some(raw) = &number.raw {
        raw.clone()
      } else if number.value.is_nan() {
        "(0 / 0)".to_string()
      } else if number.value == f64::INFINITY {
        "(1 / 0)".to_string()
      } else if number.value == f64::NEG_INFINITY {
        "(-1 / 0)".to_string()
      } else if number.value == 0.0 && number.value.is_sign_negative() {
        "-0".to_string()
      } else {
        number.value.to_string()
      }
    }
    Value::Array(values) => format!(
      "[{}]",
      values
        .iter()
        .map(value_to_source)
        .collect::<Vec<_>>()
        .join(", ")
    ),
    Value::Object(values) => format!(
      "{{ {} }}",
      values
        .iter()
        .map(|(key, value)| format!(
          "{}: {}",
          serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
          value_to_source(value)
        ))
        .collect::<Vec<_>>()
        .join(", ")
    ),
  }
}

fn relative_span(file_ctx: &FileContext, span: swc_core::common::Span) -> (usize, usize) {
  (
    span.lo.0.saturating_sub(file_ctx.start_pos.0) as usize,
    span.hi.0.saturating_sub(file_ctx.start_pos.0) as usize,
  )
}

fn call_evaluator(
  call: &CallExpr,
  file_ctx: &FileContext,
  eval_ctx: &mut EvalContext,
  local: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let shared = state(eval_ctx);
  shared.borrow_mut().depth += 1;
  let result = evaluate_macro(call, file_ctx, eval_ctx, local, options);
  let mut transform = shared.borrow_mut();
  transform.depth -= 1;
  if transform.depth == 0
    && let Ok(value) = &result
  {
    let (start, end) = relative_span(file_ctx, call.span);
    transform
      .replacements
      .entry(file_ctx.file_path.clone())
      .or_default()
      .push(Replacement {
        start,
        end,
        source: value_to_source(value),
      });
  }
  result
}

struct ContextReference<'a> {
  parameter: &'a str,
  found: bool,
}

impl Visit for ContextReference<'_> {
  fn visit_ident(&mut self, value: &Ident) {
    if value.sym.as_str() == self.parameter {
      self.found = true;
    }
  }
}

fn references_context(expression: &Expr, parameter: &str) -> bool {
  let mut visitor = ContextReference {
    parameter,
    found: false,
  };
  expression.visit_with(&mut visitor);
  visitor.found
}

fn identifier_name(value: &str) -> bool {
  let mut bytes = value.bytes();
  let Some(first) = bytes.next() else {
    return false;
  };
  (first.is_ascii_alphabetic() || matches!(first, b'_' | b'$'))
    && bytes.all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'$'))
}

fn primitive_expr(value: &Value, span: swc_core::common::Span) -> Option<Expr> {
  Some(match value {
    Value::String(value) => Expr::Lit(Lit::Str(Str {
      span,
      value: value.clone().into(),
      raw: None,
    })),
    Value::Number(value) if value.value.is_finite() => Expr::Lit(Lit::Num(Number {
      span,
      value: value.value,
      raw: value.raw.clone().map(Into::into),
    })),
    Value::Bool(value) => Expr::Lit(Lit::Bool(Bool {
      span,
      value: *value,
    })),
    Value::Null => Expr::Lit(Lit::Null(Null { span })),
    Value::Undefined => Expr::Ident(Ident::new_no_ctxt("undefined".into(), span)),
    _ => return None,
  })
}

fn computed_context_property(
  expression: &Expr,
  file_ctx: &FileContext,
) -> Result<String, ConfTSError> {
  if let Expr::Lit(Lit::Str(value)) = expression {
    let value = value.value.as_str().unwrap_or("");
    if identifier_name(value) {
      return Ok(value.to_string());
    }
  }
  let (line, column) = get_location(&file_ctx.source_map, expression.span().lo);
  Err(ConfTSError::new(
    "expr callback can only access context properties with identifier property names",
    &file_ctx.file_path,
    line,
    column,
  ))
}

struct ExprRewriter<'a> {
  parameter: &'a str,
  file_ctx: &'a FileContext,
  eval_ctx: &'a mut EvalContext,
  options: &'a CompileOptions,
  error: Option<ConfTSError>,
}

impl ExprRewriter<'_> {
  fn fail(&mut self, expression: &Expr, message: impl Into<String>) {
    if self.error.is_some() {
      return;
    }
    let (line, column) = get_location(&self.file_ctx.source_map, expression.span().lo);
    self.error = Some(ConfTSError::new(
      message,
      &self.file_ctx.file_path,
      line,
      column,
    ));
  }

  fn replace_context_member(&mut self, member: &mut MemberExpr) -> Option<Expr> {
    let Expr::Ident(object) = member.obj.as_ref() else {
      return None;
    };
    if object.sym.as_str() != self.parameter {
      return None;
    }
    let name = match &mut member.prop {
      MemberProp::Ident(value) => value.sym.as_str().to_string(),
      MemberProp::Computed(value) => {
        value.expr.visit_mut_with(self);
        match computed_context_property(&value.expr, self.file_ctx) {
          Ok(value) => value,
          Err(error) => {
            self.error = Some(error);
            return None;
          }
        }
      }
      MemberProp::PrivateName(_) => {
        self.fail(
          &Expr::Member(member.clone()),
          "expr callback contains unsupported syntax",
        );
        return None;
      }
    };
    Some(Expr::Ident(Ident::new_no_ctxt(name.into(), member.span)))
  }

  fn should_fold(expression: &Expr) -> bool {
    matches!(expression, Expr::Ident(_) | Expr::Member(_) | Expr::Call(_))
  }
}

impl VisitMut for ExprRewriter<'_> {
  fn visit_mut_expr(&mut self, expression: &mut Expr) {
    if self.error.is_some() {
      return;
    }

    let originally_referenced_context = references_context(expression, self.parameter);
    loop {
      let inner = match expression {
        Expr::TsAs(value) => Some(value.expr.as_ref().clone()),
        Expr::TsConstAssertion(value) => Some(value.expr.as_ref().clone()),
        Expr::TsInstantiation(value) => Some(value.expr.as_ref().clone()),
        Expr::TsNonNull(value) => Some(value.expr.as_ref().clone()),
        Expr::TsSatisfies(value) => Some(value.expr.as_ref().clone()),
        Expr::TsTypeAssertion(value) => Some(value.expr.as_ref().clone()),
        _ => None,
      };
      if let Some(inner) = inner {
        *expression = inner;
      } else {
        break;
      }
    }

    if let Expr::Member(member) = expression
      && let Some(replacement) = self.replace_context_member(member)
    {
      *expression = replacement;
      return;
    }

    if let Expr::Ident(value) = expression {
      if value.sym.as_str() == self.parameter {
        self.fail(
          expression,
          "expr callback cannot use the context parameter directly",
        );
        return;
      }
      let is_macro_binding = state(self.eval_ctx)
        .borrow()
        .imports
        .get(&self.file_ctx.file_path)
        .is_some_and(|bindings| bindings.named.contains_key(&value.to_id()));
      if is_macro_binding {
        return;
      }
    }

    match expression {
      Expr::Assign(_) | Expr::Update(_) | Expr::Seq(_) | Expr::Yield(_) | Expr::Await(_) => {
        self.fail(expression, "parse expression error");
        return;
      }
      Expr::Arrow(_) | Expr::Fn(_) | Expr::Class(_) | Expr::New(_) => {
        self.fail(expression, "expr callback contains unsupported syntax");
        return;
      }
      _ => {}
    }

    expression.visit_mut_children_with(self);
    if let Expr::Call(call) = expression {
      if let Some(name) = canonical_callee(call, self.file_ctx, self.eval_ctx) {
        if matches!(name.as_str(), "String" | "Number" | "Boolean") && call.args.len() != 1 {
          self.fail(
            expression,
            format!("Unsupported call expression in macro mode: {}", name),
          );
          return;
        }
      } else {
        return;
      }
    }

    if self.error.is_some()
      || originally_referenced_context
      || references_context(expression, self.parameter)
    {
      return;
    }

    if !Self::should_fold(expression) {
      return;
    }
    match evaluate(expression, self.file_ctx, self.eval_ctx, None, self.options) {
      Ok(value) => {
        if let Some(value) = primitive_expr(&value, expression.span()) {
          *expression = value;
        }
      }
      Err(error) if matches!(expression, Expr::Ident(_)) => {
        self.error = Some(error);
      }
      Err(error) if matches!(expression, Expr::Call(_)) => {
        self.error = Some(error);
      }
      Err(_) => {}
    }
  }
}

fn encode_string(value: &str, quote: QuoteStyle) -> String {
  let json = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
  if quote == QuoteStyle::Double {
    return json;
  }
  let inner = json[1..json.len() - 1]
    .replace("\\\"", "\"")
    .replace('\'', "\\'");
  format!("'{}'", inner)
}

struct NormalizeStrings {
  quote: QuoteStyle,
}

impl VisitMut for NormalizeStrings {
  fn visit_mut_str(&mut self, value: &mut Str) {
    value.raw = value
      .value
      .as_str()
      .map(|value| encode_string(value, self.quote).into());
  }
}

fn render_expression(expression: &Expr, source_map: Lrc<SourceMap>) -> Result<String, ConfTSError> {
  let mut bytes = Vec::new();
  {
    let writer = JsWriter::new(source_map.clone(), "\n", &mut bytes, None);
    let mut emitter = Emitter {
      cfg: CodegenConfig::default(),
      cm: source_map,
      comments: None,
      wr: writer,
    };
    expression.emit_with(&mut emitter).map_err(|error| {
      ConfTSError::new(
        format!("Failed to emit expr macro output: {}", error),
        "unknown",
        1,
        1,
      )
    })?;
  }
  String::from_utf8(bytes).map_err(|error| {
    ConfTSError::new(
      format!("Failed to encode expr macro output: {}", error),
      "unknown",
      1,
      1,
    )
  })
}

fn evaluate_expr(
  name: &str,
  call: &CallExpr,
  file_ctx: &FileContext,
  eval_ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<Option<Value>, ConfTSError> {
  if name != "expr" {
    return Ok(None);
  }
  if call.args.len() != 1 || call.args[0].spread.is_some() {
    let (line, column) = get_location(&file_ctx.source_map, call.span.lo);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      column,
    ));
  }
  let Expr::Arrow(callback) = call.args[0].expr.as_ref() else {
    let (line, column) = get_location(&file_ctx.source_map, call.args[0].span().lo);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      column,
    ));
  };
  if callback.is_async || callback.is_generator || callback.params.len() != 1 {
    let (line, column) = get_location(&file_ctx.source_map, callback.span.lo);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      column,
    ));
  }
  let Pat::Ident(parameter) = &callback.params[0] else {
    let (line, column) = get_location(&file_ctx.source_map, callback.params[0].span().lo);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      column,
    ));
  };
  let BlockStmtOrExpr::Expr(body) = callback.body.as_ref() else {
    let (line, column) = get_location(&file_ctx.source_map, callback.body.span().lo);
    return Err(ConfTSError::new(
      EXPR_CALLBACK_ERROR,
      &file_ctx.file_path,
      line,
      column,
    ));
  };

  let mut body = body.as_ref().clone();
  let mut rewriter = ExprRewriter {
    parameter: parameter.id.sym.as_str(),
    file_ctx,
    eval_ctx,
    options,
    error: None,
  };
  body.visit_mut_with(&mut rewriter);
  if let Some(error) = rewriter.error {
    return Err(error);
  }
  let quote = state(eval_ctx).borrow().options.quote;
  body.visit_mut_with(&mut NormalizeStrings { quote });
  let output = render_expression(&body, file_ctx.source_map.clone())?;
  Ok(Some(Value::String(output)))
}

struct OuterCalls<'a> {
  imports: &'a MacroBindings,
  calls: Vec<CallExpr>,
}

impl Visit for OuterCalls<'_> {
  fn visit_call_expr(&mut self, call: &CallExpr) {
    if canonical_from_bindings(call, self.imports).is_some() {
      self.calls.push(call.clone());
      return;
    }
    call.visit_children_with(self);
  }
}

#[derive(Default)]
struct DeclaredBindings {
  ids: HashSet<Id>,
}

impl Visit for DeclaredBindings {
  fn visit_binding_ident(&mut self, value: &BindingIdent) {
    self.ids.insert(value.id.to_id());
  }

  fn visit_import_decl(&mut self, value: &ImportDecl) {
    for specifier in &value.specifiers {
      let local = match specifier {
        ImportSpecifier::Named(value) => &value.local,
        ImportSpecifier::Default(value) => &value.local,
        ImportSpecifier::Namespace(value) => &value.local,
      };
      self.ids.insert(local.to_id());
    }
  }

  fn visit_fn_decl(&mut self, value: &FnDecl) {
    self.ids.insert(value.ident.to_id());
    value.function.visit_children_with(self);
  }

  fn visit_class_decl(&mut self, value: &ClassDecl) {
    self.ids.insert(value.ident.to_id());
    value.class.visit_children_with(self);
  }

  fn visit_fn_expr(&mut self, value: &FnExpr) {
    if let Some(identifier) = &value.ident {
      self.ids.insert(identifier.to_id());
    }
    value.function.visit_children_with(self);
  }

  fn visit_class_expr(&mut self, value: &ClassExpr) {
    if let Some(identifier) = &value.ident {
      self.ids.insert(identifier.to_id());
    }
    value.class.visit_children_with(self);
  }
}

struct MissingMacroCalls<'a> {
  declared: &'a HashSet<Id>,
  file_ctx: &'a FileContext,
  error: Option<ConfTSError>,
}

impl Visit for MissingMacroCalls<'_> {
  fn visit_call_expr(&mut self, call: &CallExpr) {
    if self.error.is_some() {
      return;
    }
    if let Callee::Expr(callee) = &call.callee
      && let Expr::Ident(identifier) = callee.as_ref()
    {
      let name = identifier.sym.as_str();
      if MACRO_FUNCTIONS.contains(&name) && !self.declared.contains(&identifier.to_id()) {
        let valid_shape = match name {
          "String" | "Number" | "Boolean" => call.args.len() == 1,
          "expr" => true,
          "env" => matches!(call.args.len(), 1 | 2),
          "arrayMap" | "arrayFilter" | "arrayFlatMap" => call.args.len() == 2,
          _ => false,
        };
        if !valid_shape {
          call.visit_children_with(self);
          return;
        }
        let message = if matches!(name, "String" | "Number" | "Boolean") {
          format!(
            "Type casting function '{name}' must be imported from '@conf-ts/macro' to use in macro mode"
          )
        } else {
          format!(
            "Macro function '{name}' must be imported from '@conf-ts/macro' to use in macro mode"
          )
        };
        let (line, column) = get_location(&self.file_ctx.source_map, call.span.lo);
        self.error = Some(ConfTSError::new(
          message,
          &self.file_ctx.file_path,
          line,
          column,
        ));
        return;
      }
    }
    call.visit_children_with(self);
  }
}

struct NamespaceUsage {
  binding: Id,
  macro_only: bool,
}

impl Visit for NamespaceUsage {
  fn visit_import_decl(&mut self, _: &ImportDecl) {}

  fn visit_call_expr(&mut self, call: &CallExpr) {
    let is_macro_call = match &call.callee {
      Callee::Expr(callee) => match callee.as_ref() {
        Expr::Member(member) => {
          let namespace = matches!(
            member.obj.as_ref(),
            Expr::Ident(value) if value.to_id() == self.binding
          );
          let property = match &member.prop {
            MemberProp::Ident(value) => value.sym.as_str(),
            MemberProp::Computed(value) => match value.expr.as_ref() {
              Expr::Lit(Lit::Str(value)) => value.value.as_str().unwrap_or(""),
              _ => "",
            },
            MemberProp::PrivateName(_) => "",
          };
          namespace && MACRO_FUNCTIONS.contains(&property)
        }
        _ => false,
      },
      _ => false,
    };
    if is_macro_call {
      call.args.visit_with(self);
      return;
    }
    call.visit_children_with(self);
  }

  fn visit_ident(&mut self, value: &Ident) {
    if value.to_id() == self.binding {
      self.macro_only = false;
    }
  }
}

fn namespace_macro_only(module: &Module, binding: Id) -> bool {
  let mut usage = NamespaceUsage {
    binding,
    macro_only: true,
  };
  module.visit_with(&mut usage);
  usage.macro_only
}

fn source_text(file_ctx: &FileContext, span: swc_core::common::Span) -> String {
  let (start, end) = relative_span(file_ctx, span);
  file_ctx.source[start..end].to_string()
}

fn import_replacements(file_ctx: &FileContext) -> Result<Vec<Replacement>, ConfTSError> {
  let mut replacements = Vec::new();
  for item in &file_ctx.module.body {
    let ModuleItem::ModuleDecl(ModuleDecl::Import(declaration)) = item else {
      continue;
    };
    if declaration.src.value.as_str() != Some(MACRO_MODULE) {
      continue;
    }
    let (start, end) = relative_span(file_ctx, declaration.span);
    if declaration.type_only {
      continue;
    }
    let default_binding = declaration
      .specifiers
      .iter()
      .find_map(|specifier| match specifier {
        ImportSpecifier::Default(value) => Some(value.local.sym.as_str().to_string()),
        _ => None,
      });
    let namespace = declaration
      .specifiers
      .iter()
      .find_map(|specifier| match specifier {
        ImportSpecifier::Namespace(value) => Some(value.local.to_id()),
        _ => None,
      });
    let module_text = source_text(file_ctx, declaration.src.span);
    let source = if let Some(namespace) = namespace {
      if !namespace_macro_only(&file_ctx.module, namespace) {
        continue;
      }
      default_binding
        .map(|value| format!("import {} from {};", value, module_text))
        .unwrap_or_default()
    } else {
      let named: Vec<&ImportNamedSpecifier> = declaration
        .specifiers
        .iter()
        .filter_map(|specifier| match specifier {
          ImportSpecifier::Named(value) => Some(value),
          _ => None,
        })
        .collect();
      let remaining: Vec<&ImportNamedSpecifier> = named
        .iter()
        .copied()
        .filter(|specifier| {
          let canonical = specifier
            .imported
            .as_ref()
            .map(export_name)
            .unwrap_or_else(|| specifier.local.sym.as_str().to_string());
          specifier.is_type_only || !MACRO_FUNCTIONS.contains(&canonical.as_str())
        })
        .collect();
      if remaining.len() == named.len() {
        continue;
      }
      if remaining.is_empty() && default_binding.is_none() {
        String::new()
      } else {
        let mut clauses = Vec::new();
        if let Some(default_binding) = default_binding {
          clauses.push(default_binding);
        }
        if !remaining.is_empty() {
          clauses.push(format!(
            "{{ {} }}",
            remaining
              .iter()
              .map(|value| source_text(file_ctx, value.span))
              .collect::<Vec<_>>()
              .join(", ")
          ));
        }
        format!("import {} from {};", clauses.join(", "), module_text)
      }
    };
    replacements.push(Replacement { start, end, source });
  }
  Ok(replacements)
}

fn normalize_replacements(mut replacements: Vec<Replacement>) -> Vec<Replacement> {
  replacements.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
  });
  let mut non_overlapping: Vec<Replacement> = Vec::new();
  for replacement in replacements {
    if non_overlapping
      .last()
      .is_some_and(|parent| replacement.start >= parent.start && replacement.end <= parent.end)
    {
      continue;
    }
    non_overlapping.push(replacement);
  }
  non_overlapping
}

fn apply_replacements(source: &str, replacements: Vec<Replacement>) -> String {
  let mut non_overlapping = normalize_replacements(replacements);
  non_overlapping.sort_by_key(|replacement| std::cmp::Reverse(replacement.start));
  let mut output = source.to_string();
  for replacement in non_overlapping {
    if replacement.start <= replacement.end && replacement.end <= output.len() {
      output.replace_range(replacement.start..replacement.end, &replacement.source);
    }
  }
  output
}

fn line_column(source: &str, offset: usize) -> (u32, u32) {
  let prefix = &source[..offset.min(source.len())];
  let line = prefix.bytes().filter(|value| *value == b'\n').count() as u32;
  let line_start = prefix.rfind('\n').map_or(0, |value| value + 1);
  let column = prefix[line_start..].encode_utf16().count() as u32;
  (line, column)
}

fn add_segment_mappings(
  points: &mut Vec<(usize, usize)>,
  generated_start: usize,
  original_start: usize,
  segment: &str,
  copied: bool,
) {
  points.push((generated_start, original_start));
  for (index, value) in segment.bytes().enumerate() {
    if value == b'\n' && index + 1 < segment.len() {
      points.push((
        generated_start + index + 1,
        if copied {
          original_start + index + 1
        } else {
          original_start
        },
      ));
    }
  }
}

fn apply_replacements_with_map(
  filename: &str,
  source: &str,
  replacements: Vec<Replacement>,
) -> Result<(String, serde_json::Value), ConfTSError> {
  let replacements = normalize_replacements(replacements);
  let mut output = String::new();
  let mut points = Vec::new();
  let mut original_cursor = 0;
  for replacement in replacements {
    let copied = &source[original_cursor..replacement.start];
    add_segment_mappings(&mut points, output.len(), original_cursor, copied, true);
    output.push_str(copied);
    if !replacement.source.is_empty() {
      add_segment_mappings(
        &mut points,
        output.len(),
        replacement.start,
        &replacement.source,
        false,
      );
      output.push_str(&replacement.source);
    }
    original_cursor = replacement.end;
  }
  let tail = &source[original_cursor..];
  add_segment_mappings(&mut points, output.len(), original_cursor, tail, true);
  output.push_str(tail);

  points.sort_unstable();
  points.dedup();
  let mut builder = swc_sourcemap::SourceMapBuilder::new(Some(filename.to_string().into()));
  let source_id = builder.add_source(filename.to_string().into());
  builder.set_source_contents(source_id, Some(source.to_string().into()));
  for (generated, original) in points {
    let (generated_line, generated_column) = line_column(&output, generated);
    let (original_line, original_column) = line_column(source, original);
    builder.add(
      generated_line,
      generated_column,
      original_line,
      original_column,
      Some(filename.to_string().into()),
      None,
      false,
    );
  }
  let mut bytes = Vec::new();
  builder
    .into_sourcemap()
    .to_writer(&mut bytes)
    .map_err(|error| {
      ConfTSError::new(
        format!("Failed to emit source map: {}", error),
        filename,
        1,
        1,
      )
    })?;
  let map = serde_json::from_slice(&bytes).map_err(|error| {
    ConfTSError::new(
      format!("Failed to encode source map: {}", error),
      filename,
      1,
      1,
    )
  })?;
  Ok((output, map))
}

pub fn transform_source(
  input: TransformInput,
  mut options: TransformOptions,
) -> Result<TransformOutput, ConfTSError> {
  if options.inherit_process_env {
    let explicit = options.env.clone();
    options.env = std::env::vars().collect();
    options.env.extend(explicit);
  }

  let mut snapshot = input.project.unwrap_or_default();
  snapshot
    .files
    .insert(input.filename.clone(), input.code.clone());
  let (contexts, _) = build_contexts(&snapshot.files)?;
  let entry = contexts.get(&input.filename).cloned().ok_or_else(|| {
    ConfTSError::new(
      format!("Entry file not found: {}", input.filename),
      &input.filename,
      1,
      1,
    )
  })?;

  let imports: HashMap<String, MacroBindings> = contexts
    .iter()
    .map(|(filename, context)| (filename.clone(), macro_imports(&context.module)))
    .collect();
  let shared = Rc::new(RefCell::new(TransformState {
    imports: imports.clone(),
    options: options.clone(),
    ..Default::default()
  }));
  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = contexts.clone();
  let files = snapshot.files.clone();
  let resolutions = snapshot.resolutions.clone();
  let compiler_options = snapshot
    .compiler_options
    .clone()
    .and_then(|value| serde_json::from_value::<TsCompilerOptions>(value).ok());
  eval_ctx.resolver = Some(Box::new(move |specifier, from_file| {
    resolutions
      .get(from_file)
      .and_then(|values| values.get(specifier))
      .cloned()
      .or_else(|| {
        resolve_module_in_memory_with_options(
          specifier,
          from_file,
          &files,
          compiler_options.as_ref(),
        )
      })
  }));
  eval_ctx.call_evaluator = Some(call_evaluator);
  let extension: Rc<dyn Any> = shared.clone();
  eval_ctx.extension = Some(extension);

  let evaluation_options = compile_options(&options);
  collect_enums(&contexts, &mut eval_ctx, &evaluation_options);

  let entry_imports = imports.get(&input.filename).cloned().unwrap_or_default();
  let mut declared = DeclaredBindings::default();
  entry.module.visit_with(&mut declared);
  let mut missing = MissingMacroCalls {
    declared: &declared.ids,
    file_ctx: &entry,
    error: None,
  };
  entry.module.visit_with(&mut missing);
  if let Some(error) = missing.error {
    return Err(error);
  }
  let mut calls = OuterCalls {
    imports: &entry_imports,
    calls: Vec::new(),
  };
  entry.module.visit_with(&mut calls);
  for call in calls.calls {
    evaluate(
      &Expr::Call(call),
      &entry,
      &mut eval_ctx,
      None,
      &evaluation_options,
    )?;
  }

  let mut replacements = shared
    .borrow_mut()
    .replacements
    .remove(&input.filename)
    .unwrap_or_default();
  replacements.extend(import_replacements(&entry)?);
  let (code, map) = if options.source_map {
    let (code, map) = apply_replacements_with_map(&input.filename, &input.code, replacements)?;
    (code, Some(map))
  } else {
    (apply_replacements(&input.code, replacements), None)
  };
  let mut dependencies: Vec<String> = eval_ctx.evaluated_files.into_iter().collect();
  dependencies.extend(snapshot.dependencies);
  dependencies.push(input.filename.clone());
  dependencies.sort();
  dependencies.dedup();

  Ok(TransformOutput {
    map,
    code,
    dependencies,
  })
}

/// SWC-AST adapter used by the standard plugin. The macro evaluation itself
/// remains source-oriented so both N-API and plugin entry points share one
/// implementation and one snapshot contract.
pub fn transform_program(
  program: Program,
  filename: String,
  project: Option<ProjectSnapshot>,
  options: TransformOptions,
) -> Result<Program, ConfTSError> {
  let code = swc_core::ecma::codegen::to_code(&program);
  let output = transform_source(
    TransformInput {
      filename: filename.clone(),
      code,
      project,
    },
    options,
  )?;
  let source_map: Lrc<SourceMap> = Lrc::new(SourceMap::default());
  Ok(Program::Module(parse_ts_file(
    &output.code,
    &filename,
    &source_map,
  )?))
}
