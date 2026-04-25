use std::collections::{HashMap, HashSet};

use swc_common::{SourceMap, sync::Lrc};
use swc_ecma_ast::*;

use crate::compiler::parse_ts_file;
use crate::error::ConfTSError;
use crate::eval::{EvalContext, collect_imports, collect_macro_imports, evaluate, resolve_in_file};
use crate::resolver::resolve_module_in_memory;
use crate::types::{CompileOptions, FileContext, Value, replace_raw_number_markers};

fn export_name_to_string(name: &ModuleExportName) -> String {
  match name {
    ModuleExportName::Ident(ident) => ident.sym.as_str().to_string(),
    ModuleExportName::Str(s) => s.value.as_str().unwrap_or("").to_string(),
  }
}

/// Compile from in-memory files (browser mode).
pub fn compile_in_memory(
  files: &HashMap<String, String>,
  entry_file: &str,
  format: &str,
  macro_mode: bool,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let source_map: Lrc<SourceMap> = Lrc::new(SourceMap::default());

  let mut file_contexts: HashMap<String, FileContext> = HashMap::new();
  for (file_name, source) in files {
    if file_name.ends_with(".ts")
      || file_name.ends_with(".tsx")
      || file_name.ends_with(".js")
      || file_name.ends_with(".jsx")
    {
      let module = parse_ts_file(source, file_name, &source_map)?;
      let imports = collect_imports(&module);
      file_contexts.insert(
        file_name.clone(),
        FileContext {
          file_path: file_name.clone(),
          module,
          source_map: source_map.clone(),
          imports,
        },
      );
    }
  }

  let effective_macro = options.macro_mode || macro_mode;
  let mut effective_options = options.clone();
  effective_options.macro_mode = effective_macro;

  let mut eval_ctx = EvalContext::new();
  eval_ctx.file_contexts = file_contexts.clone();

  let files_clone = files.clone();
  eval_ctx.resolver = Some(Box::new(move |specifier: &str, from_file: &str| {
    resolve_module_in_memory(specifier, from_file, &files_clone)
  }));

  // Collect macro imports
  for (file_path, ctx) in &file_contexts {
    let imports = collect_macro_imports(&ctx.module, file_path);
    eval_ctx
      .macro_imports_map
      .insert(file_path.clone(), imports);
  }

  // Collect enums
  let file_paths: Vec<String> = file_contexts.keys().cloned().collect();
  for file_path in &file_paths {
    let ctx = file_contexts.get(file_path).unwrap().clone();
    let module = &ctx.module;
    for item in &module.body {
      let decl = match item {
        ModuleItem::Stmt(Stmt::Decl(Decl::TsEnum(e))) => Some(e.as_ref()),
        ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
          if let Decl::TsEnum(e) = &export.decl {
            Some(e.as_ref())
          } else {
            None
          }
        }
        _ => None,
      };

      if let Some(enum_decl) = decl {
        let enum_name = enum_decl.id.sym.as_str();
        let mut next_enum_value: i64 = 0;

        for member in &enum_decl.members {
          let member_name = match &member.id {
            TsEnumMemberId::Ident(ident) => ident.sym.as_str().to_string(),
            TsEnumMemberId::Str(s) => s.value.as_str().unwrap_or("").to_string(),
          };
          let full_name = format!("{}.{}", enum_name, member_name);

          if let Some(ref init) = member.init {
            let mut enum_eval_files = HashSet::new();
            std::mem::swap(&mut eval_ctx.evaluated_files, &mut enum_eval_files);
            match evaluate(init, &ctx, &mut eval_ctx, None, &effective_options) {
              Ok(val) => {
                if let Value::Number(n) = &val {
                  next_enum_value = n.value as i64 + 1;
                }
                eval_ctx
                  .enum_map
                  .entry(file_path.clone())
                  .or_default()
                  .insert(full_name, val);
              }
              Err(_) => {
                eval_ctx
                  .enum_map
                  .entry(file_path.clone())
                  .or_default()
                  .insert(full_name, Value::number(next_enum_value as f64));
                next_enum_value += 1;
              }
            }
            std::mem::swap(&mut eval_ctx.evaluated_files, &mut enum_eval_files);
          } else {
            eval_ctx
              .enum_map
              .entry(file_path.clone())
              .or_default()
              .insert(full_name, Value::number(next_enum_value as f64));
            next_enum_value += 1;
          }
        }
      }
    }
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

  let mut found_default = false;
  let mut output = Value::Null;

  for item in &entry_ctx.module.body {
    match item {
      ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(export)) => {
        output = evaluate(
          &export.expr,
          &entry_ctx,
          &mut eval_ctx,
          None,
          &effective_options,
        )?;
        found_default = true;
        break;
      }
      ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(named_export)) => {
        for specifier in &named_export.specifiers {
          if let ExportSpecifier::Named(named) = specifier {
            let original_name = export_name_to_string(&named.orig);
            let exported_name = named
              .exported
              .as_ref()
              .map(export_name_to_string)
              .unwrap_or_else(|| original_name.clone());
            if exported_name != "default" {
              continue;
            }
            eval_ctx.evaluated_files.insert(entry_ctx.file_path.clone());
            let target_ctx = if let Some(src) = &named_export.src {
              let resolved = resolve_module_in_memory(
                src.value.as_str().unwrap_or(""),
                &entry_ctx.file_path,
                files,
              );
              resolved.and_then(|path| eval_ctx.file_contexts.get(&path).cloned())
            } else {
              Some(entry_ctx.clone())
            };
            if let Some(target_ctx) = target_ctx {
              if let Some(value) = resolve_in_file(
                &original_name,
                &target_ctx,
                &mut eval_ctx,
                None,
                &effective_options,
              )? {
                output = value;
                found_default = true;
                break;
              }
            }
          }
        }
        if found_default {
          break;
        }
      }
      _ => {}
    }
  }

  if !found_default {
    return Err(ConfTSError::new(
      format!("No default export found in the entry file: {}", entry_file),
      entry_file,
      1,
      1,
    ));
  }

  let file_names: Vec<String> = eval_ctx.evaluated_files.into_iter().collect();

  match format {
    "json" => {
      let json_value = output.to_json();
      let json_str = serde_json::to_string_pretty(&json_value).map_err(|e| {
        ConfTSError::new(format!("Failed to serialize JSON: {}", e), "unknown", 1, 1)
      })?;
      Ok((replace_raw_number_markers(&json_str), file_names))
    }
    "yaml" => {
      let yaml_value = output.to_yaml();
      let yaml_str = serde_yaml::to_string(&yaml_value).map_err(|e| {
        ConfTSError::new(format!("Failed to serialize YAML: {}", e), "unknown", 1, 1)
      })?;

      // Post-process to match JS compiler (yaml-library) format:
      // 1. Remove leading --- and newline
      let processed = yaml_str
        .strip_prefix("---\n")
        .unwrap_or(&yaml_str)
        .to_string();

      // 2. Adjust array item indentation and quotes
      let mut processed_lines = String::new();
      for line in processed.lines() {
        let mut new_line = line.to_string();
        let indent_len = new_line.len() - new_line.trim_start().len();
        if new_line[indent_len..].starts_with('\'') {
          if let Some(rel_key_end) = new_line[indent_len + 1..].find("':") {
            let key_end = indent_len + 1 + rel_key_end;
            new_line.replace_range(key_end..key_end + 1, "\"");
            new_line.replace_range(indent_len..indent_len + 1, "\"");
          }
        }
        // Convert single quotes to double quotes (heuristic for strings)
        // For simple key: 'value' or - 'value'
        if (new_line.contains(": '") || new_line.contains("- '")) && new_line.ends_with('\'') {
          new_line = new_line.replace('\'', "\"");
        }
        processed_lines.push_str(&new_line);
        processed_lines.push_str("\n");
      }

      Ok((replace_raw_number_markers(&processed_lines), file_names))
    }
    _ => Err(ConfTSError::new(
      format!("Unsupported format: {}", format),
      "unknown",
      1,
      1,
    )),
  }
}
