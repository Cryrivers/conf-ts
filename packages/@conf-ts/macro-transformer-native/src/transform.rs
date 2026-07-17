//! Oxc-backed source transformation implementation used by the N-API adapter.

mod macro_eval;

use std::any::Any;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use compiler_native::browser::{ProjectResolutions, build_file_contexts};
use compiler_native::compiler::collect_enums;
use compiler_native::error::ConfTSError;
use compiler_native::eval::EvalContext;
use compiler_native::resolver::{TsCompilerOptions, resolve_module_in_memory_with_options};
use compiler_native::types::{CompileOptions, FileContext, TransformState, Value};
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::SymbolId;
use serde::{Deserialize, Serialize};

pub use compiler_native::types::QuoteStyle;

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

#[derive(Debug, Clone)]
pub struct TransformOptions {
  pub env: HashMap<String, String>,
  pub quote: QuoteStyle,
  pub preserve_key_order: bool,
  pub source_map: bool,
  pub inherit_process_env: bool,
}

impl Default for TransformOptions {
  fn default() -> Self {
    Self {
      env: HashMap::new(),
      quote: QuoteStyle::Double,
      preserve_key_order: false,
      source_map: false,
      inherit_process_env: false,
    }
  }
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

#[derive(Debug, Clone, Default)]
struct MacroBindings {
  named: HashMap<SymbolId, String>,
  namespaces: HashSet<SymbolId>,
}

#[derive(Debug)]
struct CoreState {
  bindings: HashMap<String, MacroBindings>,
}

fn core_state(ctx: &EvalContext) -> Rc<CoreState> {
  ctx
    .extension
    .as_ref()
    .and_then(|value| value.clone().downcast::<CoreState>().ok())
    .expect("macro transformer binding state is installed")
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
}

impl<'a> Visit<'a> for EvaluateMacroCalls<'_, '_> {
  fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
    if canonical_callee(call, self.file_ctx, self.eval_ctx).is_some() {
      if macro_evaluator(call, self.file_ctx, self.eval_ctx, None, self.options).is_err() {
        // Leave calls that cannot be statically evaluated (including their
        // nested calls) untouched. The import is retained below so the
        // resulting source remains structurally valid.
        self.skipped_macro = true;
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
  let mut replacements = normalize_replacements(replacements);
  replacements.sort_by_key(|replacement| std::cmp::Reverse(replacement.start));
  let mut output = source.to_string();
  for replacement in replacements {
    output.replace_range(replacement.start..replacement.end, &replacement.source);
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
  let mut builder = oxc_sourcemap::SourceMapBuilder::default();
  builder.set_file(filename);
  let source_id = builder.set_source_and_content(filename, source);
  for (generated, original) in points {
    let (generated_line, generated_column) = line_column(&output, generated);
    let (original_line, original_column) = line_column(source, original);
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
  let contexts = build_file_contexts(&snapshot.files)?;
  let entry = contexts.get(&input.filename).cloned().ok_or_else(|| {
    ConfTSError::new(
      format!("Entry file not found: {}", input.filename),
      &input.filename,
      1,
      1,
    )
  })?;

  let bindings: HashMap<String, MacroBindings> = contexts
    .iter()
    .map(|(filename, context)| (filename.clone(), macro_bindings(context.program())))
    .collect();

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
      .and_then(|table| table.get(specifier))
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
  eval_ctx.macro_evaluator = Some(macro_evaluator);
  eval_ctx.transform_state = Some(Rc::new(RefCell::new(TransformState::default())));
  let extension: Rc<dyn Any> = Rc::new(CoreState { bindings });
  eval_ctx.extension = Some(extension);

  let evaluation_options = compile_options(&options);
  let file_paths: Vec<String> = contexts.keys().cloned().collect();
  for filename in file_paths {
    let context = contexts
      .get(&filename)
      .expect("file context should exist")
      .clone();
    collect_enums(
      context.program(),
      &filename,
      &mut eval_ctx,
      &context,
      &evaluation_options,
    );
  }

  let mut calls = EvaluateMacroCalls {
    file_ctx: &entry,
    eval_ctx: &mut eval_ctx,
    options: &evaluation_options,
    skipped_macro: false,
  };
  calls.visit_program(entry.program());
  let skipped_macro = calls.skipped_macro;

  let state = eval_ctx
    .transform_state
    .as_ref()
    .expect("replacement state should exist");
  let mut replacements = state
    .borrow_mut()
    .replacements
    .remove(&input.filename)
    .unwrap_or_default()
    .into_iter()
    .map(|(start, end, source)| Replacement {
      start: start as usize,
      end: end as usize,
      source,
    })
    .collect::<Vec<_>>();
  if !skipped_macro {
    replacements.extend(import_replacements(&entry));
  }

  let (code, map) = if options.source_map {
    let (code, map) = apply_replacements_with_map(&input.filename, &input.code, replacements)?;
    (code, Some(map))
  } else {
    (apply_replacements(&input.code, replacements), None)
  };

  let mut dependencies: Vec<String> = eval_ctx.evaluated_files.into_iter().collect();
  dependencies.extend(snapshot.dependencies);
  dependencies.push(input.filename);
  dependencies.sort();
  dependencies.dedup();

  Ok(TransformOutput {
    code,
    map,
    dependencies,
  })
}
