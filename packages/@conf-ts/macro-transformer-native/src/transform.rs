//! Oxc-backed source transformation implementation used by the N-API adapter.

mod macro_eval;

use std::any::Any;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use compiler_native::browser::{ProjectResolutions, build_file_contexts};
use compiler_native::compiler::collect_enums;
use compiler_native::error::ConfTSError;
use compiler_native::eval::{EvalContext, MACRO_FUNCTIONS};
use compiler_native::resolver::{TsCompilerOptions, resolve_module_in_memory_with_options};
use compiler_native::types::{CompileOptions, FileContext, TransformState, Value};
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::SymbolId;

pub use compiler_native::types::QuoteStyle;

const MACRO_MODULE: &str = "@conf-ts/macro";

pub struct TransformOptions {
  pub env: HashMap<String, String>,
  pub quote: QuoteStyle,
  pub preserve_key_order: bool,
  pub source_map: bool,
  pub inherit_process_env: bool,
}

#[derive(Default)]
pub struct ProjectSnapshot {
  pub files: HashMap<String, String>,
  pub resolutions: ProjectResolutions,
  pub compiler_options: Option<serde_json::Value>,
  pub dependencies: Vec<String>,
}

pub struct TransformOutput {
  pub code: String,
  pub map: Option<serde_json::Value>,
  pub dependencies: Vec<String>,
}

pub struct TransformProjectOutput {
  pub transformed: HashMap<String, TransformOutput>,
  pub dependencies: Vec<String>,
}

#[derive(Debug, Clone)]
struct Replacement {
  start: usize,
  end: usize,
  source: String,
}

#[derive(Debug, Clone, Default)]
struct MacroBindings {
  named: HashMap<SymbolId, String>,
  namespaces: HashSet<SymbolId>,
}

#[derive(Debug)]
struct CoreState {
  bindings: HashMap<String, MacroBindings>,
  fatal_error: RefCell<Option<ConfTSError>>,
}

fn core_state(ctx: &EvalContext) -> Rc<CoreState> {
  ctx
    .extension
    .as_ref()
    .and_then(|value| value.clone().downcast::<CoreState>().ok())
    .expect("macro transformer binding state is installed")
}

pub(crate) fn record_fatal_transform_error(ctx: &EvalContext, error: ConfTSError) {
  *core_state(ctx).fatal_error.borrow_mut() = Some(error);
}

fn take_fatal_transform_error(ctx: &EvalContext) -> Option<ConfTSError> {
  core_state(ctx).fatal_error.borrow_mut().take()
}

fn module_export_name(value: &ModuleExportName<'_>) -> String {
  match value {
    ModuleExportName::IdentifierName(value) => value.name.as_str().to_string(),
    ModuleExportName::IdentifierReference(value) => value.name.as_str().to_string(),
    ModuleExportName::StringLiteral(value) => value.value.as_str().to_string(),
  }
}

fn reference_symbol(
  identifier: &IdentifierReference<'_>,
  file_ctx: &FileContext,
) -> Option<SymbolId> {
  identifier.reference_id.get().and_then(|reference| {
    file_ctx
      .parsed
      .scoping()
      .get_reference(reference)
      .symbol_id()
  })
}

fn macro_bindings(program: &Program<'_>) -> MacroBindings {
  let mut bindings = MacroBindings::default();
  for statement in &program.body {
    let Statement::ImportDeclaration(declaration) = statement else {
      continue;
    };
    if declaration.source.value.as_str() != MACRO_MODULE
      || declaration.import_kind == ImportOrExportKind::Type
    {
      continue;
    }
    let Some(specifiers) = &declaration.specifiers else {
      continue;
    };
    for specifier in specifiers {
      match specifier {
        ImportDeclarationSpecifier::ImportSpecifier(specifier)
          if specifier.import_kind == ImportOrExportKind::Value =>
        {
          let canonical = module_export_name(&specifier.imported);
          if MACRO_FUNCTIONS.contains(&canonical.as_str())
            && let Some(symbol) = specifier.local.symbol_id.get()
          {
            bindings.named.insert(symbol, canonical);
          }
        }
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
          if let Some(symbol) = specifier.local.symbol_id.get() {
            bindings.namespaces.insert(symbol);
          }
        }
        _ => {}
      }
    }
  }
  bindings
}

fn namespace_callee<'a>(
  call: &'a CallExpression<'a>,
  file_ctx: &FileContext,
) -> Option<(SymbolId, &'a str)> {
  let (object, property) = match &call.callee {
    Expression::StaticMemberExpression(member) => {
      let Expression::Identifier(object) = &member.object else {
        return None;
      };
      (object, member.property.name.as_str())
    }
    Expression::ComputedMemberExpression(member) => {
      let Expression::Identifier(object) = &member.object else {
        return None;
      };
      let Expression::StringLiteral(property) = &member.expression else {
        return None;
      };
      (object, property.value.as_str())
    }
    _ => return None,
  };
  Some((reference_symbol(object, file_ctx)?, property))
}

fn canonical_from_bindings(
  call: &CallExpression<'_>,
  file_ctx: &FileContext,
  bindings: &MacroBindings,
) -> Option<String> {
  match &call.callee {
    Expression::Identifier(identifier) => bindings
      .named
      .get(&reference_symbol(identifier, file_ctx)?)
      .cloned(),
    _ => {
      let (symbol, property) = namespace_callee(call, file_ctx)?;
      (bindings.namespaces.contains(&symbol) && MACRO_FUNCTIONS.contains(&property))
        .then(|| property.to_string())
    }
  }
}

pub(crate) fn canonical_callee(
  call: &CallExpression<'_>,
  file_ctx: &FileContext,
  ctx: &EvalContext,
) -> Option<String> {
  core_state(ctx)
    .bindings
    .get(&file_ctx.file_path)
    .and_then(|bindings| canonical_from_bindings(call, file_ctx, bindings))
}

fn unwrap_expr_origin<'a>(expression: &'a Expression<'a>) -> &'a Expression<'a> {
  match expression {
    Expression::ParenthesizedExpression(value) => unwrap_expr_origin(&value.expression),
    Expression::TSAsExpression(value) => unwrap_expr_origin(&value.expression),
    Expression::TSSatisfiesExpression(value) => unwrap_expr_origin(&value.expression),
    Expression::TSNonNullExpression(value) => unwrap_expr_origin(&value.expression),
    Expression::TSTypeAssertion(value) => unwrap_expr_origin(&value.expression),
    _ => expression,
  }
}

fn const_initializer_by_name<'a>(
  program: &'a Program<'a>,
  name: &str,
  symbol: Option<SymbolId>,
) -> Option<&'a Expression<'a>> {
  fn from_declaration<'a>(
    declaration: &'a VariableDeclaration<'a>,
    name: &str,
    symbol: Option<SymbolId>,
  ) -> Option<&'a Expression<'a>> {
    if declaration.kind != VariableDeclarationKind::Const {
      return None;
    }
    declaration.declarations.iter().find_map(|declarator| {
      let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
        return None;
      };
      let matches_binding = symbol.map_or_else(
        || identifier.name.as_str() == name,
        |symbol| identifier.symbol_id.get() == Some(symbol),
      );
      matches_binding
        .then_some(declarator.init.as_ref())
        .flatten()
    })
  }

  for statement in &program.body {
    match statement {
      Statement::VariableDeclaration(declaration) => {
        if let Some(initializer) = from_declaration(declaration, name, symbol) {
          return Some(initializer);
        }
      }
      Statement::ExportNamedDeclaration(export) => {
        if let Some(Declaration::VariableDeclaration(declaration)) = &export.declaration
          && let Some(initializer) = from_declaration(declaration, name, symbol)
        {
          return Some(initializer);
        }
      }
      _ => {}
    }
  }
  None
}

fn exported_expr_origin(
  export_name: &str,
  file_ctx: &FileContext,
  ctx: &EvalContext,
  visited: &mut HashSet<(String, String)>,
) -> bool {
  for statement in &file_ctx.program().body {
    match statement {
      Statement::ExportNamedDeclaration(export) => {
        if export.source.is_some() {
          continue;
        }
        if let Some(Declaration::VariableDeclaration(declaration)) = &export.declaration
          && declaration.kind == VariableDeclarationKind::Const
        {
          for declarator in &declaration.declarations {
            let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
              continue;
            };
            if identifier.name.as_str() == export_name
              && let Some(initializer) = &declarator.init
            {
              return expression_originates_from_expr_inner(initializer, file_ctx, ctx, visited);
            }
          }
        }
        for specifier in &export.specifiers {
          if module_export_name(&specifier.exported) == export_name {
            let local_name = module_export_name(&specifier.local);
            if let Some(initializer) =
              const_initializer_by_name(file_ctx.program(), &local_name, None)
            {
              return expression_originates_from_expr_inner(initializer, file_ctx, ctx, visited);
            }
          }
        }
      }
      Statement::ExportDefaultDeclaration(export) if export_name == "default" => {
        if let Some(expression) = export.declaration.as_expression() {
          return expression_originates_from_expr_inner(expression, file_ctx, ctx, visited);
        }
      }
      _ => {}
    }
  }
  false
}

fn expression_originates_from_expr_inner(
  expression: &Expression<'_>,
  file_ctx: &FileContext,
  ctx: &EvalContext,
  visited: &mut HashSet<(String, String)>,
) -> bool {
  match unwrap_expr_origin(expression) {
    Expression::CallExpression(call) => {
      canonical_callee(call, file_ctx, ctx).as_deref() == Some("expr")
    }
    Expression::Identifier(identifier) => {
      let name = identifier.name.as_str();
      let key = (file_ctx.file_path.clone(), name.to_string());
      if !visited.insert(key) {
        return false;
      }
      if let Some(initializer) = const_initializer_by_name(
        file_ctx.program(),
        name,
        reference_symbol(identifier, file_ctx),
      ) {
        return expression_originates_from_expr_inner(initializer, file_ctx, ctx, visited);
      }
      let Some(import) = file_ctx.imports.get(name) else {
        return false;
      };
      let Some(resolved_path) = ctx
        .resolver
        .as_ref()
        .and_then(|resolver| resolver(&import.source, &file_ctx.file_path))
      else {
        return false;
      };
      let Some(imported_ctx) = ctx.file_contexts.get(&resolved_path) else {
        return false;
      };
      exported_expr_origin(
        import.original_name.as_deref().unwrap_or(name),
        imported_ctx,
        ctx,
        visited,
      )
    }
    _ => false,
  }
}

pub(crate) fn expression_originates_from_expr(
  expression: &Expression<'_>,
  file_ctx: &FileContext,
  ctx: &EvalContext,
) -> bool {
  expression_originates_from_expr_inner(expression, file_ctx, ctx, &mut HashSet::new())
}

fn compile_options(options: &TransformOptions) -> CompileOptions {
  CompileOptions {
    preserve_key_order: options.preserve_key_order,
    env: Some(options.env.clone()),
    quote: options.quote,
  }
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

fn macro_evaluator(
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let state = ctx
    .transform_state
    .clone()
    .expect("macro transform replacement state is installed");
  state.borrow_mut().depth += 1;
  let result = macro_eval::evaluate_macro(call, file_ctx, ctx, local, options);
  let mut state = state.borrow_mut();
  state.depth -= 1;
  if state.depth == 0
    && let Ok(value) = &result
  {
    state
      .replacements
      .entry(file_ctx.file_path.clone())
      .or_default()
      .push((call.span.start, call.span.end, value_to_source(value)));
  }
  result
}

struct EvaluateMacroCalls<'a, 'b> {
  file_ctx: &'a FileContext,
  eval_ctx: &'b mut EvalContext,
  options: &'a CompileOptions,
  skipped_macro: bool,
  fatal_error: Option<ConfTSError>,
}

fn warn_skipped_macro(call: &CallExpression, file_ctx: &FileContext, error: &ConfTSError) {
  eprintln!(
    "[@conf-ts/macro-transformer] Skipped a macro call that could not be statically transformed; it will likely fail at a later compile step instead:\n    {}\n    in: {}",
    error,
    source_text(file_ctx, call.span),
  );
}

impl<'a> Visit<'a> for EvaluateMacroCalls<'_, '_> {
  fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
    if self.fatal_error.is_some() {
      return;
    }
    if canonical_callee(call, self.file_ctx, self.eval_ctx).is_some() {
      if let Err(error) = macro_evaluator(call, self.file_ctx, self.eval_ctx, None, self.options) {
        if let Some(fatal) = take_fatal_transform_error(self.eval_ctx) {
          self.fatal_error = Some(fatal);
        } else {
          // Leave calls that cannot be statically evaluated (including their
          // nested calls) untouched. The import is retained below so the
          // resulting source remains structurally valid. Warn here (with the
          // exact call site) since a skipped macro otherwise fails silently
          // until some unrelated later stage trips over the untransformed
          // call, at which point the error location no longer points at the
          // real cause.
          self.skipped_macro = true;
          warn_skipped_macro(call, self.file_ctx, &error);
        }
      }
      return;
    }
    walk::walk_call_expression(self, call);
  }
}

struct NamespaceUsage<'a> {
  file_ctx: &'a FileContext,
  symbol: SymbolId,
  has_non_macro_use: bool,
}

impl<'a> Visit<'a> for NamespaceUsage<'_> {
  fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
    if namespace_callee(call, self.file_ctx).is_some_and(|(symbol, property)| {
      symbol == self.symbol && MACRO_FUNCTIONS.contains(&property)
    }) {
      for argument in &call.arguments {
        self.visit_argument(argument);
      }
      return;
    }
    walk::walk_call_expression(self, call);
  }

  fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
    if reference_symbol(identifier, self.file_ctx) == Some(self.symbol) {
      self.has_non_macro_use = true;
    }
  }
}

fn namespace_macro_only(file_ctx: &FileContext, symbol: SymbolId) -> bool {
  let mut usage = NamespaceUsage {
    file_ctx,
    symbol,
    has_non_macro_use: false,
  };
  usage.visit_program(file_ctx.program());
  !usage.has_non_macro_use
}

fn source_text(file_ctx: &FileContext, span: oxc_span::Span) -> &str {
  &file_ctx.parsed.source()[span.start as usize..span.end as usize]
}

fn import_replacements(file_ctx: &FileContext) -> Vec<Replacement> {
  let mut replacements = Vec::new();
  for statement in &file_ctx.program().body {
    let Statement::ImportDeclaration(declaration) = statement else {
      continue;
    };
    if declaration.source.value.as_str() != MACRO_MODULE
      || declaration.import_kind == ImportOrExportKind::Type
    {
      continue;
    }
    let Some(specifiers) = &declaration.specifiers else {
      continue;
    };

    let default_binding = specifiers.iter().find_map(|specifier| match specifier {
      ImportDeclarationSpecifier::ImportDefaultSpecifier(value) => {
        Some(value.local.name.as_str().to_string())
      }
      _ => None,
    });
    let namespace = specifiers.iter().find_map(|specifier| match specifier {
      ImportDeclarationSpecifier::ImportNamespaceSpecifier(value) => value.local.symbol_id.get(),
      _ => None,
    });

    let source = if let Some(namespace) = namespace {
      if !namespace_macro_only(file_ctx, namespace) {
        continue;
      }
      default_binding
        .map(|binding| {
          format!(
            "import {} from {};",
            binding,
            source_text(file_ctx, declaration.source.span)
          )
        })
        .unwrap_or_default()
    } else {
      let named: Vec<&ImportSpecifier<'_>> = specifiers
        .iter()
        .filter_map(|specifier| match specifier {
          ImportDeclarationSpecifier::ImportSpecifier(value) => Some(value.as_ref()),
          _ => None,
        })
        .collect();
      let remaining: Vec<&ImportSpecifier<'_>> = named
        .iter()
        .copied()
        .filter(|specifier| {
          specifier.import_kind == ImportOrExportKind::Type
            || !MACRO_FUNCTIONS.contains(&module_export_name(&specifier.imported).as_str())
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
              .map(|specifier| source_text(file_ctx, specifier.span))
              .collect::<Vec<_>>()
              .join(", ")
          ));
        }
        format!(
          "import {} from {};",
          clauses.join(", "),
          source_text(file_ctx, declaration.source.span)
        )
      }
    };

    replacements.push(Replacement {
      start: declaration.span.start as usize,
      end: declaration.span.end as usize,
      source,
    });
  }
  replacements
}

fn normalize_replacements(mut replacements: Vec<Replacement>) -> Vec<Replacement> {
  replacements.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
  });
  let mut output: Vec<Replacement> = Vec::new();
  for replacement in replacements {
    if output
      .last()
      .is_some_and(|parent| replacement.start >= parent.start && replacement.end <= parent.end)
    {
      continue;
    }
    output.push(replacement);
  }
  output
}

fn apply_replacements(source: &str, replacements: Vec<Replacement>) -> String {
  let replacements = normalize_replacements(replacements);
  let additional: usize = replacements
    .iter()
    .map(|replacement| {
      replacement
        .source
        .len()
        .saturating_sub(replacement.end - replacement.start)
    })
    .sum();
  let mut output = String::with_capacity(source.len() + additional);
  let mut cursor = 0;
  for replacement in replacements {
    output.push_str(&source[cursor..replacement.start]);
    output.push_str(&replacement.source);
    cursor = replacement.end;
  }
  output.push_str(&source[cursor..]);
  output
}

struct Utf16LineIndex {
  starts: Vec<usize>,
}

impl Utf16LineIndex {
  fn new(source: &str) -> Self {
    let mut starts = vec![0];
    for (index, value) in source.bytes().enumerate() {
      if value == b'\n' {
        starts.push(index + 1);
      }
    }
    Self { starts }
  }

  fn line_column(&self, source: &str, offset: usize) -> (u32, u32) {
    let offset = offset.min(source.len());
    let line = match self.starts.binary_search(&offset) {
      Ok(index) => index,
      Err(index) => index.saturating_sub(1),
    };
    let column = source[self.starts[line]..offset].encode_utf16().count();
    (line as u32, column as u32)
  }
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
  let mut builder = oxc_sourcemap::SourceMapBuilder::default();
  builder.set_file(filename);
  let source_id = builder.set_source_and_content(filename, source);
  let generated_lines = Utf16LineIndex::new(&output);
  let original_lines = Utf16LineIndex::new(source);
  for (generated, original) in points {
    let (generated_line, generated_column) = generated_lines.line_column(&output, generated);
    let (original_line, original_column) = original_lines.line_column(source, original);
    builder.add_token(
      generated_line,
      generated_column,
      original_line,
      original_column,
      Some(source_id),
      None,
    );
  }
  let map = serde_json::from_str(&builder.into_sourcemap().to_json_string()).map_err(|error| {
    ConfTSError::new(
      format!("Failed to encode source map: {}", error),
      filename,
      1,
      1,
    )
  })?;
  Ok((output, map))
}

fn transform_context(
  filename: &str,
  source: &str,
  entry: &FileContext,
  eval_ctx: &mut EvalContext,
  evaluation_options: &CompileOptions,
  source_map: bool,
) -> Result<TransformOutput, ConfTSError> {
  eval_ctx.evaluated_files.clear();
  if let Some(state) = &eval_ctx.transform_state {
    *state.borrow_mut() = TransformState::default();
  }
  *core_state(eval_ctx).fatal_error.borrow_mut() = None;

  let mut calls = EvaluateMacroCalls {
    file_ctx: entry,
    eval_ctx,
    options: evaluation_options,
    skipped_macro: false,
    fatal_error: None,
  };
  calls.visit_program(entry.program());
  if let Some(error) = calls.fatal_error {
    return Err(error);
  }
  let skipped_macro = calls.skipped_macro;

  let state = eval_ctx
    .transform_state
    .as_ref()
    .expect("replacement state should exist");
  let mut replacements = state
    .borrow_mut()
    .replacements
    .remove(filename)
    .unwrap_or_default()
    .into_iter()
    .map(|(start, end, source)| Replacement {
      start: start as usize,
      end: end as usize,
      source,
    })
    .collect::<Vec<_>>();
  if !skipped_macro {
    replacements.extend(import_replacements(entry));
  }

  let (code, map) = if source_map {
    let (code, map) = apply_replacements_with_map(filename, source, replacements)?;
    (code, Some(map))
  } else {
    (apply_replacements(source, replacements), None)
  };
  let mut dependencies: Vec<String> = eval_ctx.evaluated_files.iter().cloned().collect();
  dependencies.push(filename.to_string());
  dependencies.sort();
  dependencies.dedup();
  Ok(TransformOutput {
    code,
    map,
    dependencies,
  })
}

pub fn transform_project(
  snapshot: ProjectSnapshot,
  files: Option<Vec<String>>,
  mut options: TransformOptions,
) -> Result<TransformProjectOutput, ConfTSError> {
  if options.inherit_process_env {
    let explicit = options.env.clone();
    options.env = std::env::vars().collect();
    options.env.extend(explicit);
  }

  let mut targets = files.unwrap_or_else(|| snapshot.files.keys().cloned().collect());
  targets.sort();
  targets.dedup();
  for filename in &targets {
    if !snapshot.files.contains_key(filename) {
      return Err(ConfTSError::new(
        format!("Source file is missing from macro project: {}", filename),
        filename,
        1,
        1,
      ));
    }
  }
  targets.retain(|filename| {
    snapshot
      .files
      .get(filename)
      .is_some_and(|source| source.contains(MACRO_MODULE) || source.contains('\\'))
  });
  if targets.is_empty() {
    return Ok(TransformProjectOutput {
      transformed: HashMap::new(),
      dependencies: Vec::new(),
    });
  }

  let contexts = build_file_contexts(&snapshot.files)?;

  let bindings: HashMap<String, MacroBindings> = contexts
    .iter()
    .map(|(filename, context)| (filename.clone(), macro_bindings(context.program())))
    .collect();
  targets.retain(|filename| {
    bindings
      .get(filename)
      .is_some_and(|value| !value.named.is_empty() || !value.namespaces.is_empty())
  });
  if targets.is_empty() {
    return Ok(TransformProjectOutput {
      transformed: HashMap::new(),
      dependencies: Vec::new(),
    });
  }

  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = contexts.clone();
  let files = snapshot.files.clone();
  let resolutions = snapshot.resolutions.clone();
  let compiler_options = snapshot
    .compiler_options
    .clone()
    .and_then(|value| serde_json::from_value::<TsCompilerOptions>(value).ok());
  let resolution_memo: RefCell<HashMap<(String, String), Option<String>>> =
    RefCell::new(HashMap::new());
  eval_ctx.resolver = Some(Box::new(move |specifier, from_file| {
    let key = (from_file.to_string(), specifier.to_string());
    if let Some(value) = resolution_memo.borrow().get(&key) {
      return value.clone();
    }
    let resolved = resolutions
      .get(from_file)
      .and_then(|table| table.get(specifier))
      .cloned()
      .or_else(|| {
        resolve_module_in_memory_with_options(
          specifier,
          from_file,
          &files,
          compiler_options.as_ref(),
        )
      });
    resolution_memo.borrow_mut().insert(key, resolved.clone());
    resolved
  }));
  eval_ctx.macro_evaluator = Some(macro_evaluator);
  eval_ctx.transform_state = Some(Rc::new(RefCell::new(TransformState::default())));
  let extension: Rc<dyn Any> = Rc::new(CoreState {
    bindings,
    fatal_error: RefCell::new(None),
  });
  eval_ctx.extension = Some(extension);

  let evaluation_options = compile_options(&options);
  for (filename, context) in &contexts {
    collect_enums(
      context.program(),
      filename,
      &mut eval_ctx,
      context,
      &evaluation_options,
    );
  }

  let mut transformed = HashMap::new();
  let mut dependencies = Vec::new();
  for filename in targets {
    let entry = contexts
      .get(&filename)
      .expect("validated transform target should have a context");
    let source = snapshot
      .files
      .get(&filename)
      .expect("validated transform target should have source");
    let result = transform_context(
      &filename,
      source,
      entry,
      &mut eval_ctx,
      &evaluation_options,
      options.source_map,
    )?;
    dependencies.extend(result.dependencies.iter().cloned());
    transformed.insert(filename, result);
  }
  dependencies.sort();
  dependencies.dedup();
  Ok(TransformProjectOutput {
    transformed,
    dependencies,
  })
}

pub fn transform_source(
  filename: String,
  code: String,
  project: Option<ProjectSnapshot>,
  options: TransformOptions,
) -> Result<TransformOutput, ConfTSError> {
  let mut snapshot = project.unwrap_or_default();
  snapshot.files.insert(filename.clone(), code.clone());
  let legacy_dependencies = snapshot.dependencies.clone();
  let source_map = options.source_map;
  let mut output = transform_project(snapshot, Some(vec![filename.clone()]), options)?;
  let mut result = output.transformed.remove(&filename).unwrap_or_else(|| {
    let (code, map) = if source_map {
      let (code, map) = apply_replacements_with_map(&filename, &code, Vec::new())
        .expect("an empty replacement source map should be valid");
      (code, Some(map))
    } else {
      (code, None)
    };
    TransformOutput {
      code,
      map,
      dependencies: vec![filename.clone()],
    }
  });
  result.dependencies.extend(legacy_dependencies);
  result.dependencies.sort();
  result.dependencies.dedup();
  Ok(result)
}
