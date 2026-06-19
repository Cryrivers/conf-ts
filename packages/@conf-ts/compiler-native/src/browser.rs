use std::collections::{HashMap, HashSet};

use oxc_ast::ast::*;

use crate::compiler::parse_ts_file;
use crate::error::ConfTSError;
use crate::eval::{
  EvalContext, collect_imports, collect_macro_imports, evaluate, find_default_export,
};
use crate::resolver::resolve_module_in_memory;
use crate::types::{CompileOptions, FileContext, Value, serialize_output};

/// Compile from in-memory files (browser mode).
pub fn compile_in_memory(
  files: &HashMap<String, String>,
  entry_file: &str,
  format: &str,
  macro_mode: bool,
  options: &CompileOptions,
) -> Result<(String, Vec<String>), ConfTSError> {
  let mut file_contexts: HashMap<String, FileContext> = HashMap::new();
  for (file_name, source) in files {
    if file_name.ends_with(".ts")
      || file_name.ends_with(".tsx")
      || file_name.ends_with(".js")
      || file_name.ends_with(".jsx")
    {
      let (parsed, line_index) = parse_ts_file(source, file_name)?;
      let imports = collect_imports(parsed.program());
      file_contexts.insert(
        file_name.clone(),
        FileContext {
          file_path: file_name.clone(),
          parsed,
          line_index,
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

  for (file_path, ctx) in &file_contexts {
    let imports = collect_macro_imports(ctx.program(), file_path);
    eval_ctx
      .macro_imports_map
      .insert(file_path.clone(), imports);
  }

  let file_paths: Vec<String> = file_contexts.keys().cloned().collect();
  for file_path in &file_paths {
    let ctx = file_contexts.get(file_path).unwrap().clone();
    for stmt in &ctx.program().body {
      let decl = match stmt {
        Statement::TSEnumDeclaration(e) => Some(e.as_ref()),
        Statement::ExportNamedDeclaration(export) => {
          if let Some(Declaration::TSEnumDeclaration(e)) = &export.declaration {
            Some(e.as_ref())
          } else {
            None
          }
        }
        _ => None,
      };

      if let Some(enum_decl) = decl {
        let enum_name = enum_decl.id.name.as_str();
        let mut next_enum_value: i64 = 0;

        for member in &enum_decl.body.members {
          let member_name = match &member.id {
            TSEnumMemberName::Identifier(ident) => ident.name.as_str().to_string(),
            TSEnumMemberName::String(s) => s.value.as_str().to_string(),
            _ => continue,
          };
          let full_name = format!("{}.{}", enum_name, member_name);

          if let Some(ref init) = member.initializer {
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

  let output = find_default_export(&entry_ctx, &mut eval_ctx, &effective_options)?;

  let file_names: Vec<String> = eval_ctx.evaluated_files.into_iter().collect();
  let serialized = serialize_output(&output, format)?;
  Ok((serialized, file_names))
}
