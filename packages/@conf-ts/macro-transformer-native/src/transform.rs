use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use compiler_native::browser::{build_file_contexts, create_in_memory_eval_context};
use compiler_native::compiler::{
  collect_enums, collect_enums_for_all, create_eval_context, load_file_program,
};
use compiler_native::error::ConfTSError;
use compiler_native::eval::{EvalContext, find_default_export};
use compiler_native::types::{CompileOptions, FileContext, TransformResult, TransformState, Value};
use oxc_ast::ast::CallExpression;

use crate::macro_eval::evaluate_macro;

/// Rust port of the JS transformer's `valueToSource`: serialize an already
/// -evaluated macro `Value` back into literal source text, so the ordinary
/// constants-only pass can pick it up as though it were always there.
/// Must stay in sync with @conf-ts/macro-transformer/src/index.ts's
/// `valueToSource`, since Phase F parity tests assert both transformers
/// produce byte-identical rewritten output.
fn value_to_source(value: &Value) -> String {
  match value {
    Value::Undefined => "undefined".to_string(),
    Value::Null => "null".to_string(),
    Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
    Value::Bool(b) => b.to_string(),
    Value::Number(n) => {
      if let Some(raw) = &n.raw {
        return raw.clone();
      }
      let v = n.value;
      if v.is_nan() {
        "(0 / 0)".to_string()
      } else if v == f64::INFINITY {
        "(1 / 0)".to_string()
      } else if v == f64::NEG_INFINITY {
        "(-1 / 0)".to_string()
      } else if v == 0.0 && v.is_sign_negative() {
        "-0".to_string()
      } else {
        v.to_string()
      }
    }
    Value::Array(items) => format!(
      "[{}]",
      items
        .iter()
        .map(value_to_source)
        .collect::<Vec<_>>()
        .join(", ")
    ),
    Value::Object(entries) => format!(
      "{{ {} }}",
      entries
        .iter()
        .map(|(k, v)| format!(
          "{}: {}",
          serde_json::to_string(k).unwrap_or_else(|_| "\"\"".to_string()),
          value_to_source(v)
        ))
        .collect::<Vec<_>>()
        .join(", ")
    ),
  }
}

/// Keep only the outermost, non-overlapping replacements (mirrors the JS
/// transformer's `nonOverlapping`): if a macro call's argument also
/// resolved to a recorded replacement, the argument's replacement is
/// contained entirely within the outer call's span and must be discarded.
fn non_overlapping(mut replacements: Vec<(u32, u32, String)>) -> Vec<(u32, u32, String)> {
  replacements.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
  let mut result: Vec<(u32, u32, String)> = Vec::new();
  for r in replacements {
    if let Some(parent) = result.last() {
      if r.0 >= parent.0 && r.1 <= parent.1 {
        continue;
      }
    }
    result.push(r);
  }
  result
}

fn apply_replacements(source: &str, replacements: Vec<(u32, u32, String)>) -> String {
  let mut sorted = non_overlapping(replacements);
  sorted.sort_by(|a, b| b.0.cmp(&a.0));
  let mut output = source.to_string();
  for (start, end, text) in sorted {
    output.replace_range(start as usize..end as usize, &text);
  }
  output
}

/// The `fn` pointer installed as `EvalContext.macro_evaluator`. Wraps the
/// real macro-evaluation logic (moved here from compiler-native) with
/// nesting-depth tracking, so only the outermost macro call in a nested
/// macro expression gets a source-text replacement recorded — inner calls
/// just contribute to computing the outer call's value.
///
/// Borrow discipline (do not change without re-reading this comment): the
/// `RefCell` borrow is always taken briefly and dropped *before* the
/// recursive `evaluate_macro` call below, never held open across it. That's
/// what keeps nested macro calls (e.g. `arrayMap(arr, item => expr(...))`)
/// reentrant-safe — holding the guard across the recursive call would
/// panic with `BorrowMutError` the moment a nested macro call reached this
/// same function again.
fn evaluate_macro_hook(
  call: &CallExpression,
  file_ctx: &FileContext,
  ctx: &mut EvalContext,
  local_context: Option<&HashMap<String, Value>>,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  let state = ctx
    .transform_state
    .clone()
    .expect("transform_state must be set whenever macro_evaluator is set");
  state.borrow_mut().depth += 1;

  let result = evaluate_macro(call, file_ctx, ctx, local_context, options);

  let mut state_ref = state.borrow_mut();
  state_ref.depth -= 1;
  if state_ref.depth == 0 {
    if let Ok(ref value) = result {
      state_ref
        .replacements
        .entry(file_ctx.file_path.clone())
        .or_default()
        .push((call.span.start, call.span.end, value_to_source(value)));
    }
  }
  drop(state_ref);

  result
}

fn splice_transform_state(
  state: &TransformState,
  file_contexts: &HashMap<String, FileContext>,
) -> HashMap<String, String> {
  let mut files = HashMap::new();
  for (file_path, replacements) in &state.replacements {
    if let Some(ctx) = file_contexts.get(file_path) {
      files.insert(
        file_path.clone(),
        apply_replacements(ctx.parsed.source(), replacements.clone()),
      );
    }
  }
  files
}

/// Pre-evaluate macros in a filesystem project using the oxc API.
pub fn transform_macros(
  input_file: &str,
  options: &CompileOptions,
) -> Result<TransformResult, ConfTSError> {
  let loaded = load_file_program(input_file)?;
  let mut eval_ctx = create_eval_context(&loaded);
  let transform_state = Rc::new(RefCell::new(TransformState::default()));
  eval_ctx.macro_evaluator = Some(evaluate_macro_hook);
  eval_ctx.transform_state = Some(transform_state.clone());

  collect_enums_for_all(&loaded, &mut eval_ctx, options);

  let entry_ctx = loaded
    .file_contexts
    .get(&loaded.entry_file)
    .ok_or_else(|| {
      ConfTSError::new(
        format!("Entry file not found: {}", loaded.entry_file),
        &loaded.entry_file,
        1,
        1,
      )
    })?
    .clone();

  find_default_export(&entry_ctx, &mut eval_ctx, options)?;

  eval_ctx
    .evaluated_files
    .insert(loaded.tsconfig_path.display().to_string());

  let files = splice_transform_state(&transform_state.borrow(), &loaded.file_contexts);

  Ok(TransformResult {
    files,
    dependencies: eval_ctx.evaluated_files.into_iter().collect(),
  })
}

/// Pre-evaluate macros in an in-memory oxc project.
pub fn transform_macros_in_memory(
  files: &HashMap<String, String>,
  entry_file: &str,
  options: &CompileOptions,
) -> Result<TransformResult, ConfTSError> {
  let file_contexts = build_file_contexts(files)?;
  let mut eval_ctx = create_in_memory_eval_context(files, &file_contexts);
  let transform_state = Rc::new(RefCell::new(TransformState::default()));
  eval_ctx.macro_evaluator = Some(evaluate_macro_hook);
  eval_ctx.transform_state = Some(transform_state.clone());

  let file_paths: Vec<String> = file_contexts.keys().cloned().collect();
  for file_path in &file_paths {
    let ctx = file_contexts.get(file_path).unwrap().clone();
    collect_enums(ctx.program(), file_path, &mut eval_ctx, &ctx, options);
  }

  let entry_ctx = file_contexts
    .get(entry_file)
    .ok_or_else(|| {
      ConfTSError::new(
        format!("Entry file not found: {}", entry_file),
        entry_file,
        1,
        1,
      )
    })?
    .clone();

  find_default_export(&entry_ctx, &mut eval_ctx, options)?;

  let result_files = splice_transform_state(&transform_state.borrow(), &file_contexts);

  Ok(TransformResult {
    files: result_files,
    dependencies: eval_ctx.evaluated_files.into_iter().collect(),
  })
}
