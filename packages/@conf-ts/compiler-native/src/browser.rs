use std::collections::{HashMap, HashSet};

use swc_core::common::{SourceMap, sync::Lrc};
use swc_core::ecma::ast::*;

use crate::compiler::parse_ts_file;
use crate::error::ConfTSError;
use crate::eval::{EvalContext, collect_imports, evaluate, resolve_in_file};
use crate::resolver::{TsCompilerOptions, resolve_module_in_memory_with_options};
use crate::types::{CompileOptions, FileContext, Value, serialize_output};

pub type ProjectResolutions = HashMap<String, HashMap<String, String>>;

fn export_name_to_string(name: &ModuleExportName) -> String {
  match name {
    ModuleExportName::Ident(ident) => ident.sym.as_str().to_string(),
    ModuleExportName::Str(value) => value.value.as_str().unwrap_or("").to_string(),
  }
}

fn collect_enums(
  file_contexts: &HashMap<String, FileContext>,
  eval_ctx: &mut EvalContext,
  options: &CompileOptions,
) {
  for (file_path, file_ctx) in file_contexts {
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

      let enum_name = declaration.id.sym.as_str();
      let mut next_value = 0_i64;
      let mut local_context = HashMap::new();
      for member in &declaration.members {
        let member_name = match &member.id {
          TsEnumMemberId::Ident(value) => value.sym.as_str().to_string(),
          TsEnumMemberId::Str(value) => value.value.as_str().unwrap_or("").to_string(),
        };
        let value = if let Some(initializer) = &member.init {
          let mut enum_dependencies = HashSet::new();
          std::mem::swap(&mut eval_ctx.evaluated_files, &mut enum_dependencies);
          let result = evaluate(
            initializer,
            file_ctx,
            eval_ctx,
            Some(&local_context),
            options,
          )
          .unwrap_or_else(|_| Value::number(next_value as f64));
          std::mem::swap(&mut eval_ctx.evaluated_files, &mut enum_dependencies);
          result
        } else {
          Value::number(next_value as f64)
        };
        if let Value::Number(number) = &value {
          next_value = number.value as i64 + 1;
        } else {
          next_value += 1;
        }
        local_context.insert(member_name.clone(), value.clone());
        eval_ctx
          .enum_map
          .entry(file_path.clone())
          .or_default()
          .insert(format!("{}.{}", enum_name, member_name), value);
      }
    }
  }
}

fn evaluate_default_export(
  entry: &FileContext,
  eval_ctx: &mut EvalContext,
  options: &CompileOptions,
) -> Result<Value, ConfTSError> {
  // A default re-export evaluates the source file directly, so record the
  // re-exporting entry explicitly as part of the dependency graph.
  eval_ctx.evaluated_files.insert(entry.file_path.clone());
  for item in &entry.module.body {
    match item {
      ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(value)) => {
        return evaluate(&value.expr, entry, eval_ctx, None, options);
      }
      ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(value)) => {
        for specifier in &value.specifiers {
          let ExportSpecifier::Named(specifier) = specifier else {
            continue;
          };
          let original = export_name_to_string(&specifier.orig);
          let exported = specifier
            .exported
            .as_ref()
            .map(export_name_to_string)
            .unwrap_or_else(|| original.clone());
          if exported != "default" {
            continue;
          }
          let target = if let Some(source) = &value.src {
            eval_ctx
              .resolver
              .as_ref()
              .and_then(|resolve| resolve(source.value.as_str().unwrap_or(""), &entry.file_path))
              .and_then(|path| eval_ctx.file_contexts.get(&path).cloned())
          } else {
            Some(entry.clone())
          };
          if let Some(target) = target
            && let Some(result) = resolve_in_file(&original, &target, eval_ctx, None, options)?
          {
            return Ok(result);
          }
        }
      }
      _ => {}
    }
  }
  Err(ConfTSError::new(
    format!(
      "No default export found in the entry file: {}",
      entry.file_path
    ),
    &entry.file_path,
    1,
    1,
  ))
}

/// Compile a source project without reading the filesystem.
pub fn compile_project(
  files: &HashMap<String, String>,
  entry_file: &str,
  resolutions: Option<&ProjectResolutions>,
  compiler_options: Option<&serde_json::Value>,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let source_map: Lrc<SourceMap> = Lrc::new(SourceMap::default());
  let mut file_contexts = HashMap::new();
  for (file_name, source) in files {
    if !matches!(
      file_name.rsplit('.').next(),
      Some("ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs")
    ) {
      continue;
    }
    let module = parse_ts_file(source, file_name, &source_map)?;
    let start_pos = module.span.lo;
    file_contexts.insert(
      file_name.clone(),
      FileContext {
        file_path: file_name.clone(),
        source: source.clone(),
        start_pos,
        imports: collect_imports(&module),
        module,
        source_map: source_map.clone(),
      },
    );
  }

  let entry = file_contexts.get(entry_file).cloned().ok_or_else(|| {
    ConfTSError::new(
      format!("Entry file not found: {}", entry_file),
      entry_file,
      1,
      1,
    )
  })?;

  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = file_contexts.clone();
  let project_files = files.clone();
  let project_resolutions = resolutions.cloned().unwrap_or_default();
  let project_compiler_options = compiler_options
    .cloned()
    .and_then(|value| serde_json::from_value::<TsCompilerOptions>(value).ok());
  eval_ctx.resolver = Some(Box::new(move |specifier, from_file| {
    project_resolutions
      .get(from_file)
      .and_then(|table| table.get(specifier))
      .cloned()
      .or_else(|| {
        resolve_module_in_memory_with_options(
          specifier,
          from_file,
          &project_files,
          project_compiler_options.as_ref(),
        )
      })
  }));

  collect_enums(&file_contexts, &mut eval_ctx, options);
  let output = evaluate_default_export(&entry, &mut eval_ctx, options)?;
  let dependencies = eval_ctx.evaluated_files.into_iter().collect();
  Ok((serialize_output(&output, format)?, dependencies))
}

/// Backwards-compatible in-memory entry point, now implemented by the
/// source-project compiler.
pub fn compile_in_memory(
  files: &HashMap<String, String>,
  entry_file: &str,
  format: &str,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  compile_project(files, entry_file, None, None, format, options)
}
