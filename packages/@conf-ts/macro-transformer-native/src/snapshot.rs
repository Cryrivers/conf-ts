//! Filesystem-backed project snapshots for the native macro transformer.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use compiler_native::error::ConfTSError;
use oxc_allocator::Allocator;
use oxc_ast::ast::Statement;
use oxc_parser::Parser;
use oxc_resolver::{
  ExtendsField, FileMetadata, FileSystem, ResolveContext, ResolveError, ResolveOptions,
  ResolverGeneric, TsConfig, TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
};
use oxc_span::SourceType;
use serde::Deserialize;

pub type ProjectResolutions = HashMap<String, HashMap<String, String>>;

#[derive(Debug, Clone, Default)]
pub struct MacroProjectSnapshot {
  pub files: HashMap<String, String>,
  pub resolutions: ProjectResolutions,
  pub compiler_options: Option<serde_json::Value>,
  pub entry_files: Vec<String>,
  pub dependencies: Vec<String>,
  pub referenced_modules: HashMap<String, Vec<String>>,
  pub missing_dependencies: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SnapshotOptions {
  pub compiler_options: Option<serde_json::Value>,
  pub previous: Option<MacroProjectSnapshot>,
  pub overrides: HashMap<String, String>,
}

#[derive(Clone, Default)]
struct OverlayFileSystem {
  overrides: Arc<HashMap<PathBuf, String>>,
  virtual_directories: Arc<HashSet<PathBuf>>,
}

impl OverlayFileSystem {
  fn new(overrides: HashMap<String, String>) -> Self {
    let overrides: HashMap<PathBuf, String> = overrides
      .into_iter()
      .map(|(filename, source)| (PathBuf::from(filename), source))
      .collect();
    let mut virtual_directories = HashSet::new();
    for filename in overrides.keys() {
      let mut directory = filename.parent();
      while let Some(value) = directory {
        if !virtual_directories.insert(value.to_path_buf()) {
          break;
        }
        directory = value.parent();
      }
    }
    Self {
      overrides: Arc::new(overrides),
      virtual_directories: Arc::new(virtual_directories),
    }
  }

  fn override_source(&self, path: &Path) -> Option<&str> {
    self.overrides.get(path).map(String::as_str)
  }
}

impl FileSystem for OverlayFileSystem {
  fn new() -> Self {
    Self::default()
  }

  fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
    self.override_source(path).map_or_else(
      || std::fs::read(path),
      |source| Ok(source.as_bytes().to_vec()),
    )
  }

  fn read_to_string(&self, path: &Path) -> io::Result<String> {
    self.override_source(path).map_or_else(
      || std::fs::read_to_string(path),
      |source| Ok(source.to_string()),
    )
  }

  fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
    if self.overrides.contains_key(path) {
      return Ok(FileMetadata::new(true, false, false));
    }
    if self.virtual_directories.contains(path) {
      return Ok(FileMetadata::new(false, true, false));
    }
    std::fs::metadata(path).map(FileMetadata::from)
  }

  fn symlink_metadata(&self, path: &Path) -> io::Result<FileMetadata> {
    if self.overrides.contains_key(path) {
      return Ok(FileMetadata::new(true, false, false));
    }
    if self.virtual_directories.contains(path) {
      return Ok(FileMetadata::new(false, true, false));
    }
    // The resolver's tsconfig cache canonicalizes independently of its
    // `symlinks` option. Report followed metadata here as well so project
    // graph keys retain the host spelling (`/var`, junction paths, etc.).
    std::fs::metadata(path).map(FileMetadata::from)
  }

  fn read_link(&self, path: &Path) -> Result<PathBuf, ResolveError> {
    std::fs::read_link(path).map_err(ResolveError::from)
  }

  fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
    if path.is_absolute() {
      Ok(normalize_path(path))
    } else {
      std::path::absolute(path).map(|value| normalize_path(&value))
    }
  }
}

fn absolute_path(path: &str) -> Result<PathBuf, ConfTSError> {
  std::path::absolute(path)
    .map(|path| normalize_path(&path))
    .map_err(|error| {
      ConfTSError::new(
        format!("Failed to resolve absolute path: {}", error),
        path,
        1,
        1,
      )
    })
}

fn normalize_path(path: &Path) -> PathBuf {
  let mut output = PathBuf::new();
  for component in path.components() {
    match component {
      Component::CurDir => {}
      Component::ParentDir => {
        output.pop();
      }
      _ => output.push(component.as_os_str()),
    }
  }
  output
}

fn normalize_overrides(
  overrides: HashMap<String, String>,
) -> Result<HashMap<String, String>, ConfTSError> {
  overrides
    .into_iter()
    .map(|(filename, source)| {
      Ok((
        absolute_path(&filename)?.to_string_lossy().into_owned(),
        source,
      ))
    })
    .collect()
}

fn referenced_module_names(filename: &str, source: &str) -> Result<Vec<String>, ConfTSError> {
  if is_json_file(Path::new(filename)) {
    return Ok(Vec::new());
  }
  let allocator = Allocator::default();
  let source_type = SourceType::from_path(filename).unwrap_or_default();
  let parsed = Parser::new(&allocator, source, source_type).parse();
  if parsed.panicked {
    return Err(ConfTSError::new(
      format!("Failed to parse file: {}", filename),
      filename,
      1,
      1,
    ));
  }
  let mut names = Vec::new();
  for statement in &parsed.program.body {
    match statement {
      Statement::ImportDeclaration(declaration) => {
        names.push(declaration.source.value.as_str().to_string());
      }
      Statement::ExportNamedDeclaration(declaration) => {
        if let Some(source) = &declaration.source {
          names.push(source.value.as_str().to_string());
        }
      }
      Statement::ExportAllDeclaration(declaration) => {
        names.push(declaration.source.value.as_str().to_string());
      }
      _ => {}
    }
  }
  Ok(names)
}

pub fn scan_referenced_modules(
  files: &HashMap<String, String>,
) -> Result<HashMap<String, Vec<String>>, ConfTSError> {
  files
    .iter()
    .map(|(filename, source)| Ok((filename.clone(), referenced_module_names(filename, source)?)))
    .collect()
}

fn same_strings(left: Option<&Vec<String>>, right: &[String]) -> bool {
  left.is_some_and(|left| left.as_slice() == right)
}

fn can_reuse_snapshot(
  previous: &MacroProjectSnapshot,
  overrides: &HashMap<String, String>,
) -> Result<bool, ConfTSError> {
  let references = scan_referenced_modules(overrides)?;
  Ok(references.iter().all(|(filename, names)| {
    previous.files.contains_key(filename)
      && same_strings(previous.referenced_modules.get(filename), names)
  }))
}

fn merge_compiler_options(
  base: Option<serde_json::Value>,
  overrides: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
  let mut output = match base {
    Some(serde_json::Value::Object(value)) => value,
    _ => serde_json::Map::new(),
  };
  if let Some(serde_json::Value::Object(values)) = overrides {
    output.extend(values);
  }
  Some(serde_json::Value::Object(output))
}

const SOURCE_EXTENSIONS: &[&str] = &[
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json",
];

fn extensions_with_suffixes(
  extensions: &[&str],
  module_suffixes: Option<&[String]>,
) -> Vec<String> {
  module_suffixes.map_or_else(
    || {
      extensions
        .iter()
        .map(|extension| (*extension).to_string())
        .collect()
    },
    |suffixes| {
      extensions
        .iter()
        .flat_map(|extension| {
          suffixes
            .iter()
            .map(move |suffix| format!("{suffix}{extension}"))
        })
        .collect()
    },
  )
}

fn resolver_options(
  tsconfig: TsconfigDiscovery,
  module_suffixes: Option<&[String]>,
) -> ResolveOptions {
  let mut extension_alias = vec![
    (
      ".js".to_string(),
      extensions_with_suffixes(&[".ts", ".tsx", ".js", ".jsx"], module_suffixes),
    ),
    (
      ".mjs".to_string(),
      extensions_with_suffixes(&[".mts", ".mjs"], module_suffixes),
    ),
    (
      ".cjs".to_string(),
      extensions_with_suffixes(&[".cts", ".cjs"], module_suffixes),
    ),
    (
      ".jsx".to_string(),
      extensions_with_suffixes(&[".tsx", ".jsx"], module_suffixes),
    ),
  ];
  if module_suffixes.is_some() {
    extension_alias.extend(
      [".ts", ".tsx", ".mts", ".cts", ".json"]
        .into_iter()
        .map(|extension| {
          (
            extension.to_string(),
            extensions_with_suffixes(&[extension], module_suffixes),
          )
        }),
    );
  }
  ResolveOptions {
    tsconfig: Some(tsconfig),
    extensions: extensions_with_suffixes(SOURCE_EXTENSIONS, module_suffixes),
    extension_alias,
    condition_names: ["types", "import", "node"]
      .into_iter()
      .map(str::to_string)
      .collect(),
    main_fields: ["types", "module", "main"]
      .into_iter()
      .map(str::to_string)
      .collect(),
    builtin_modules: true,
    // TypeScript snapshots keep source graph paths in the spelling supplied
    // by the host. This is also required for webpack resourcePath cache keys.
    symlinks: false,
    ..ResolveOptions::default()
  }
}

fn conf_error(message: impl Into<String>, file: impl AsRef<Path>) -> ConfTSError {
  ConfTSError::new(message.into(), file.as_ref().to_string_lossy(), 1, 1)
}

fn resolved_compiler_options(
  tsconfig: &TsConfig,
  module_suffixes: Option<&[String]>,
) -> serde_json::Value {
  let options = &tsconfig.compiler_options;
  let mut output = serde_json::Map::new();
  if let Some(base_url) = &options.base_url {
    let value = if base_url.is_absolute() {
      base_url.clone()
    } else {
      normalize_path(&tsconfig.directory().join(base_url))
    };
    output.insert(
      "baseUrl".to_string(),
      serde_json::Value::String(value.to_string_lossy().into_owned()),
    );
  } else if options.paths.is_some() {
    output.insert(
      "baseUrl".to_string(),
      serde_json::Value::String(tsconfig.directory().to_string_lossy().into_owned()),
    );
  }
  if let Some(paths) = &options.paths {
    let mut values = serde_json::Map::new();
    for (pattern, targets) in paths {
      values.insert(
        pattern.clone(),
        serde_json::Value::Array(
          targets
            .iter()
            .map(|target| serde_json::Value::String(target.to_string_lossy().into_owned()))
            .collect(),
        ),
      );
    }
    output.insert("paths".to_string(), serde_json::Value::Object(values));
  }
  for (name, value) in [
    ("allowJs", options.allow_js),
    ("resolveJsonModule", options.resolve_json_module),
    ("checkJs", options.check_js),
    ("strict", options.strict),
  ] {
    if let Some(value) = value {
      output.insert(name.to_string(), serde_json::Value::Bool(value));
    }
  }
  if let Some(module_suffixes) = module_suffixes {
    output.insert(
      "moduleSuffixes".to_string(),
      serde_json::Value::Array(
        module_suffixes
          .iter()
          .map(|suffix| serde_json::Value::String(suffix.clone()))
          .collect(),
      ),
    );
  }
  serde_json::Value::Object(output)
}

#[derive(Clone, Debug, Default)]
struct TsconfigMetadata {
  dependencies: HashSet<PathBuf>,
  module_suffixes: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SnapshotTsconfig {
  compiler_options: SnapshotCompilerOptions,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SnapshotCompilerOptions {
  module_suffixes: Option<Vec<String>>,
}

fn read_module_suffixes(
  file_system: &OverlayFileSystem,
  path: &Path,
) -> Result<Option<Vec<String>>, ConfTSError> {
  let source = file_system
    .read_to_string(path)
    .map_err(|error| conf_error(format!("Failed to read tsconfig.json: {error}"), path))?;
  let mut json = source
    .strip_prefix('\u{feff}')
    .unwrap_or(&source)
    .as_bytes()
    .to_vec();
  json_strip_comments::strip_slice(&mut json)
    .map_err(|error| conf_error(format!("Failed to parse tsconfig.json: {error}"), path))?;
  if json.iter().all(u8::is_ascii_whitespace) {
    return Ok(None);
  }
  serde_json::from_slice::<SnapshotTsconfig>(&json)
    .map(|config| config.compiler_options.module_suffixes)
    .map_err(|error| conf_error(format!("Failed to parse tsconfig.json: {error}"), path))
}

fn extended_specifiers(tsconfig: &TsConfig) -> Vec<&str> {
  match &tsconfig.extends {
    Some(ExtendsField::Single(specifier)) => vec![specifier],
    Some(ExtendsField::Multiple(specifiers)) => specifiers.iter().map(String::as_str).collect(),
    None => Vec::new(),
  }
}

fn tsconfig_extends_resolver(file_system: OverlayFileSystem) -> ResolverGeneric<OverlayFileSystem> {
  ResolverGeneric::new_with_file_system(
    file_system,
    ResolveOptions {
      condition_names: vec!["node".to_string(), "import".to_string()],
      extensions: vec![".json".to_string()],
      main_files: vec!["tsconfig".to_string()],
      symlinks: false,
      ..ResolveOptions::default()
    },
  )
}

fn resolve_extended_tsconfig(
  resolver: &ResolverGeneric<OverlayFileSystem>,
  tsconfig: &TsConfig,
  specifier: &str,
) -> Result<Arc<TsConfig>, ConfTSError> {
  let path = if specifier.starts_with('.') || Path::new(specifier).is_absolute() {
    normalize_path(&tsconfig.directory().join(specifier))
  } else {
    resolver
      .resolve(tsconfig.directory(), specifier)
      .map(|resolution| resolution.into_path_buf())
      .map_err(|error| {
        conf_error(
          format!("Failed to resolve extended tsconfig: {error}"),
          tsconfig.path(),
        )
      })?
  };
  resolver.resolve_tsconfig(path).map_err(|error| {
    conf_error(
      format!("Failed to read extended tsconfig: {error}"),
      tsconfig.path(),
    )
  })
}

fn tsconfig_metadata(
  tsconfig: &TsConfig,
  file_system: &OverlayFileSystem,
  extends_resolver: &ResolverGeneric<OverlayFileSystem>,
  cache: &mut HashMap<PathBuf, TsconfigMetadata>,
  visiting: &mut HashSet<PathBuf>,
) -> Result<TsconfigMetadata, ConfTSError> {
  if let Some(metadata) = cache.get(tsconfig.path()) {
    return Ok(metadata.clone());
  }
  let path = tsconfig.path().to_path_buf();
  if !visiting.insert(path.clone()) {
    return Err(conf_error("Circular tsconfig extends chain", &path));
  }

  let result = (|| {
    let mut metadata = TsconfigMetadata::default();
    metadata.dependencies.insert(path.clone());
    for specifier in extended_specifiers(tsconfig) {
      let extended = resolve_extended_tsconfig(extends_resolver, tsconfig, specifier)?;
      let extended_metadata =
        tsconfig_metadata(&extended, file_system, extends_resolver, cache, visiting)?;
      metadata.dependencies.extend(extended_metadata.dependencies);
      if extended_metadata.module_suffixes.is_some() {
        metadata.module_suffixes = extended_metadata.module_suffixes;
      }
    }
    if let Some(module_suffixes) = read_module_suffixes(file_system, &path)? {
      metadata.module_suffixes = Some(module_suffixes);
    }
    for reference in &tsconfig.references_resolved {
      let referenced_metadata =
        tsconfig_metadata(reference, file_system, extends_resolver, cache, visiting)?;
      metadata
        .dependencies
        .extend(referenced_metadata.dependencies);
    }
    Ok(metadata)
  })();
  visiting.remove(&path);
  if let Ok(metadata) = &result {
    cache.insert(path, metadata.clone());
  }
  result
}

fn is_declaration_file(path: &Path) -> bool {
  let name = path
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or_default();
  name.ends_with(".d.ts") || name.ends_with(".d.mts") || name.ends_with(".d.cts")
}

fn is_json_file(path: &Path) -> bool {
  path.extension().and_then(|value| value.to_str()) == Some("json")
}

fn is_loadable_source(path: &Path) -> bool {
  if is_declaration_file(path) {
    return false;
  }
  matches!(
    path.extension().and_then(|value| value.to_str()),
    Some("ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" | "json")
  )
}

fn is_external_library(path: &Path) -> bool {
  path
    .components()
    .any(|component| matches!(component, Component::Normal(value) if value == "node_modules"))
}

fn sorted_paths(values: HashSet<PathBuf>) -> Vec<String> {
  let mut output: Vec<String> = values
    .into_iter()
    .map(|value| value.to_string_lossy().into_owned())
    .collect();
  output.sort();
  output.dedup();
  output
}

struct EntryGroup {
  tsconfig_path: PathBuf,
  entries: Vec<PathBuf>,
}

fn entry_groups(
  entries: &[PathBuf],
  file_system: &OverlayFileSystem,
) -> Result<Vec<EntryGroup>, ConfTSError> {
  let resolver = ResolverGeneric::new_with_file_system(
    file_system.clone(),
    resolver_options(TsconfigDiscovery::Auto, None),
  );
  let mut groups: Vec<EntryGroup> = Vec::new();
  let mut indices: HashMap<PathBuf, usize> = HashMap::new();
  for entry in entries {
    let tsconfig = resolver
      .find_tsconfig(entry)
      .map_err(|error| conf_error(format!("Failed to read tsconfig.json: {}", error), entry))?
      .ok_or_else(|| conf_error("Could not find a tsconfig.json file.", entry))?;
    let path = tsconfig.path().to_path_buf();
    if let Some(index) = indices.get(&path).copied() {
      groups[index].entries.push(entry.clone());
    } else {
      indices.insert(path.clone(), groups.len());
      groups.push(EntryGroup {
        tsconfig_path: path,
        entries: vec![entry.clone()],
      });
    }
  }
  Ok(groups)
}

fn manual_tsconfig(path: &Path) -> TsconfigDiscovery {
  TsconfigDiscovery::Manual(TsconfigOptions {
    config_file: path.to_path_buf(),
    references: TsconfigReferences::Auto,
  })
}

pub fn create_project_snapshot(
  entry_files: Vec<String>,
  options: SnapshotOptions,
) -> Result<MacroProjectSnapshot, ConfTSError> {
  if entry_files.is_empty() {
    return Err(ConfTSError::new(
      "createMacroProjectSnapshot requires an entry file",
      "",
      1,
      1,
    ));
  }

  let normalized_entries: Vec<PathBuf> = entry_files
    .iter()
    .map(|filename| absolute_path(filename))
    .collect::<Result<_, _>>()?;
  let normalized_overrides = normalize_overrides(options.overrides)?;
  if let Some(mut previous) = options.previous
    && can_reuse_snapshot(&previous, &normalized_overrides)?
  {
    previous.files.extend(normalized_overrides);
    previous.compiler_options =
      merge_compiler_options(previous.compiler_options, options.compiler_options);
    return Ok(previous);
  }

  let file_system = OverlayFileSystem::new(normalized_overrides);
  let groups = entry_groups(&normalized_entries, &file_system)?;
  let mut files = HashMap::new();
  let mut resolutions: ProjectResolutions = HashMap::new();
  let mut referenced_modules = HashMap::new();
  let mut dependencies: HashSet<PathBuf> = HashSet::new();
  let mut missing_dependencies: HashSet<PathBuf> = HashSet::new();
  let mut compiler_options = None;
  let extends_resolver = tsconfig_extends_resolver(file_system.clone());
  let mut metadata_cache = HashMap::new();

  for group in groups {
    let base_resolver = ResolverGeneric::new_with_file_system(
      file_system.clone(),
      resolver_options(manual_tsconfig(&group.tsconfig_path), None),
    );
    let tsconfig = base_resolver
      .find_tsconfig(&group.entries[0])
      .map_err(|error| {
        conf_error(
          format!("Failed to read tsconfig.json: {}", error),
          &group.tsconfig_path,
        )
      })?
      .ok_or_else(|| conf_error("Could not find a tsconfig.json file.", &group.entries[0]))?;
    let root_metadata = tsconfig_metadata(
      &tsconfig,
      &file_system,
      &extends_resolver,
      &mut metadata_cache,
      &mut HashSet::new(),
    )?;
    dependencies.extend(root_metadata.dependencies.iter().cloned());
    compiler_options.get_or_insert_with(|| {
      resolved_compiler_options(&tsconfig, root_metadata.module_suffixes.as_deref())
    });

    let mut resolvers_by_suffix = HashMap::new();
    resolvers_by_suffix.insert(
      root_metadata.module_suffixes.clone(),
      base_resolver.clone_with_options(resolver_options(
        manual_tsconfig(&group.tsconfig_path),
        root_metadata.module_suffixes.as_deref(),
      )),
    );

    let mut pending = group.entries;
    let mut visited = HashSet::new();
    let mut resolution_memo: HashMap<(PathBuf, String, PathBuf), Option<PathBuf>> = HashMap::new();
    while let Some(filename) = pending.pop() {
      if !visited.insert(filename.clone()) || is_external_library(&filename) {
        continue;
      }
      let source = file_system
        .read_to_string(&filename)
        .map_err(|error| conf_error(format!("Failed to read file: {}", error), &filename))?;
      dependencies.insert(filename.clone());
      if is_declaration_file(&filename) {
        continue;
      }

      let filename_string = filename.to_string_lossy().into_owned();
      let module_names = referenced_module_names(&filename_string, &source)?;
      files.insert(filename_string.clone(), source);
      referenced_modules.insert(filename_string.clone(), module_names.clone());
      let file_tsconfig = base_resolver.find_tsconfig(&filename).map_err(|error| {
        conf_error(
          format!("Failed to read tsconfig.json: {}", error),
          &group.tsconfig_path,
        )
      })?;
      let file_metadata = if let Some(file_tsconfig) = &file_tsconfig {
        tsconfig_metadata(
          file_tsconfig,
          &file_system,
          &extends_resolver,
          &mut metadata_cache,
          &mut HashSet::new(),
        )?
      } else {
        root_metadata.clone()
      };
      dependencies.extend(file_metadata.dependencies.iter().cloned());
      let suffix_key = file_metadata.module_suffixes;
      if !resolvers_by_suffix.contains_key(&suffix_key) {
        resolvers_by_suffix.insert(
          suffix_key.clone(),
          base_resolver.clone_with_options(resolver_options(
            manual_tsconfig(&group.tsconfig_path),
            suffix_key.as_deref(),
          )),
        );
      }
      let resolver = resolvers_by_suffix
        .get(&suffix_key)
        .expect("resolver was inserted for module suffixes");

      for module_name in module_names {
        let directory = filename.parent().unwrap_or(Path::new("/"));
        let resolution_key = (
          directory.to_path_buf(),
          module_name.clone(),
          file_tsconfig.as_ref().map_or_else(
            || group.tsconfig_path.clone(),
            |value| value.path().to_path_buf(),
          ),
        );
        let resolved = if let Some(value) = resolution_memo.get(&resolution_key) {
          value.clone()
        } else {
          let mut context = ResolveContext::default();
          let result = resolver.resolve_with_context(
            directory,
            &module_name,
            file_tsconfig.as_deref(),
            &mut context,
          );
          dependencies.extend(context.file_dependencies);
          missing_dependencies.extend(context.missing_dependencies);
          let resolved = result.ok().map(|resolution| resolution.into_path_buf());
          resolution_memo.insert(resolution_key, resolved.clone());
          resolved
        };
        let Some(resolved) = resolved else {
          continue;
        };
        if is_external_library(&resolved) {
          continue;
        }
        let resolved_string = resolved.to_string_lossy().into_owned();
        resolutions
          .entry(filename_string.clone())
          .or_default()
          .insert(module_name, resolved_string);
        if is_loadable_source(&resolved) && !visited.contains(&resolved) {
          pending.push(resolved);
        }
      }
    }
  }

  missing_dependencies.retain(|path| !dependencies.contains(path));
  Ok(MacroProjectSnapshot {
    files,
    resolutions,
    compiler_options: merge_compiler_options(compiler_options, options.compiler_options),
    entry_files: normalized_entries
      .into_iter()
      .map(|value| value.to_string_lossy().into_owned())
      .collect(),
    dependencies: sorted_paths(dependencies),
    referenced_modules,
    missing_dependencies: sorted_paths(missing_dependencies),
  })
}
