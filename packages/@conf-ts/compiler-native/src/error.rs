use std::fmt;

/// Return concise, actionable fixes for common configuration failures.
pub fn suggestions_for_error(message: &str) -> Vec<String> {
  let suggest = |values: &[&str]| values.iter().map(|value| (*value).to_string()).collect();

  if message.contains("Could not find a tsconfig.json file") {
    return suggest(&[
      "Add a tsconfig.json next to the configuration file or in one of its parent directories.",
      "If the file is generated or virtual, pass a project snapshot with compiler options instead.",
    ]);
  }
  if message.contains("Failed to parse file")
    || message.contains("parse expression error")
    || message.contains("Failed to read tsconfig.json")
    || message.contains("Invalid tsconfig.json")
    || message.contains("Failed to parse tsconfig.json")
  {
    return suggest(&[
      "Check the highlighted line for a missing or extra comma, bracket, brace, parenthesis, or quote.",
      "Fix the first reported syntax error before retrying; later errors may be caused by it.",
    ]);
  }
  if message.contains("No default export found") {
    return suggest(&[
      "Export the final configuration with `export default { ... }`.",
      "If the value lives in another file, re-export it with `export { default } from \"./file\"`.",
    ]);
  }
  if message.contains("Unsupported type: Date") {
    return suggest(&[
      "Replace `new Date(...)` with an ISO date string or a numeric timestamp.",
      "If the date must be created at runtime, keep only its static input in the configuration.",
    ]);
  }
  if message.contains("Unsupported type: Function") {
    return suggest(&[
      "Configuration output cannot contain functions; export the function's static result instead.",
      "For runtime conditions, use a supported `expr(...)` macro.",
    ]);
  }
  if message.contains("Unsupported type: RegExp") {
    return suggest(&[
      "Store the regular-expression pattern as a string and construct the RegExp at runtime.",
    ]);
  }
  if message.contains("Only 'const' declarations are supported")
    || message.contains("aliases must use const declarations")
  {
    return suggest(&[
      "Change the declaration to `const` and give it a statically evaluable initializer.",
    ]);
  }
  if message.contains("Unsupported variable type for identifier")
    || message.contains("Could not find symbol")
    || message.contains("Could not resolve shorthand property")
  {
    return suggest(&[
      "Check the identifier spelling and the import path shown in the reference chain.",
      "Declare the value with `const` and initialize it with literals or other statically evaluable values.",
    ]);
  }
  if message.contains("must be imported from '@conf-ts/macro'")
    || message.contains("only allowed in macro mode")
  {
    return suggest(&[
      "Import the function from `@conf-ts/macro`.",
      "Enable the conf-ts macro transformer before running the compiler.",
    ]);
  }
  if message.contains("callback must be an arrow function")
    || message.contains("callback must be a synchronous arrow function")
    || message.contains("expr callback must be an arrow function")
  {
    return suggest(&[
      "Replace the callback with a synchronous arrow function that has the parameter shape described by the error.",
      "Keep the callback body to a single expression when static transformation is required.",
    ]);
  }
  if message.contains("a nested function's parameter cannot shadow the context parameter") {
    return suggest(&[
      "Rename the nested callback parameter so it differs from the outer expression context, for example `item => item < 5`.",
    ]);
  }
  if message.contains("a nested function passed as a call argument must have parameters") {
    return suggest(&[
      "Rewrite the nested callback as a synchronous arrow function with a single-expression body, for example `item => item.id`.",
      "Use plain identifier parameters or one level of destructuring, and remove type annotations, `async`, generators, and nested patterns.",
    ]);
  }
  if message.contains("exprTemplate arguments must be statically analyzable")
    || message.contains("static argument")
  {
    return suggest(&[
      "Pass literals, imported constants, or values derived only from other static constants.",
      "Move runtime-dependent values into the generated expression context instead of template arguments.",
    ]);
  }
  if message.contains("exprTemplate values are compile-time-only") {
    return suggest(&[
      "Invoke the template directly, assign it to a `const` alias, or forward it through import/export.",
      "Do not place the template function itself in the generated configuration output.",
    ]);
  }
  if message.contains("Non-null assertion") {
    return suggest(&[
      "Provide a static fallback with `value ?? fallback` or remove the non-null assertion.",
      "Ensure the referenced constant cannot evaluate to `null` or `undefined`.",
    ]);
  }
  if message.contains("env macro argument must be a string")
    || message.contains("env macro default value must be a string")
  {
    return suggest(&[
      "Pass string literals for the environment-variable name and optional default, for example `env(\"PORT\", \"3000\")`.",
    ]);
  }
  if message.contains("expr callback cannot use the context parameter directly") {
    return suggest(&[
      "Access a property of the context, such as `ctx.userId`, instead of returning `ctx` itself.",
    ]);
  }
  if message.contains("Cannot read property of") {
    return suggest(&[
      "Use optional chaining and a fallback, for example `value?.property ?? fallback`.",
    ]);
  }
  if message.contains("Unsupported \"new\" expression") {
    return suggest(&[
      "Construct runtime objects outside the configuration and store only their serializable inputs here.",
    ]);
  }
  if message.contains("Cannot inline non-finite number")
    || message.contains("Cannot transform macro value of type")
  {
    return suggest(&[
      "Replace the value with a finite number, string, boolean, null, array, or plain object.",
    ]);
  }
  if message.contains("cyclic") {
    return suggest(&[
      "Remove the circular reference; configuration values must form a tree that can be serialized.",
    ]);
  }
  if message.contains("quote must be") {
    return suggest(&["Set `quote` to either \"single\" or \"double\"."]);
  }
  if message.contains("Unsupported format") {
    return suggest(&["Use either \"json\" or \"yaml\" as the output format."]);
  }
  if message.contains("Unsupported call expression") {
    return suggest(&[
      "Precompute the call result in a static `const`, or replace the call with a supported `@conf-ts/macro` function.",
      "If this is a macro call, verify that macro transformation runs before compilation.",
    ]);
  }
  if message.contains("Unsupported syntax")
    || message.contains("Unsupported binary operator")
    || message.contains("Unsupported unary operator")
    || message.contains("Unsupported property access")
    || message.contains("Unsupported element access")
  {
    return suggest(&[
      "Rewrite the highlighted expression using literals, static constants, arrays, plain objects, and supported operators.",
      "Move runtime-only logic out of the configuration or express it with a supported macro.",
    ]);
  }

  suggest(&[
    "Review the highlighted expression and replace it with a statically evaluable, JSON/YAML-compatible value.",
  ])
}

/// Source location for error reporting.
#[derive(Debug, Clone)]
pub struct SourceLocation {
  pub file: String,
  pub line: usize,
  pub character: usize,
  pub source_line: Option<String>,
}

impl SourceLocation {
  pub fn new(file: impl Into<String>, line: usize, character: usize) -> Self {
    Self {
      file: file.into(),
      line,
      character,
      source_line: None,
    }
  }

  pub fn with_source(mut self, source: &str) -> Self {
    self.source_line = source
      .lines()
      .nth(self.line.saturating_sub(1))
      .map(str::to_string);
    self
  }
}

/// A file which indirectly referenced the location where evaluation failed.
#[derive(Debug, Clone)]
pub struct SourceReference {
  pub location: SourceLocation,
  pub label: String,
}

/// The main error type, mirrors ConfTSError from the TS version.
#[derive(Debug, Clone)]
pub struct ConfTSError {
  pub message: String,
  pub location: SourceLocation,
  pub references: Vec<SourceReference>,
  pub suggestions: Box<Vec<String>>,
}

impl ConfTSError {
  pub fn new(
    message: impl Into<String>,
    file: impl Into<String>,
    line: usize,
    character: usize,
  ) -> Self {
    let message = message.into();
    let suggestions = Box::new(suggestions_for_error(&message));
    Self {
      message,
      location: SourceLocation::new(file, line, character),
      references: Vec::new(),
      suggestions,
    }
  }

  pub fn add_reference(&mut self, location: SourceLocation) {
    let duplicate = std::iter::once(&self.location)
      .chain(self.references.iter().map(|reference| &reference.location))
      .any(|existing| existing.file == location.file);
    if !duplicate {
      self.references.push(SourceReference {
        location,
        label: "referenced from".to_string(),
      });
    }
  }

  pub fn add_source(&mut self, file: &str, source: &str) {
    let add = |location: &mut SourceLocation| {
      if location.file == file && location.source_line.is_none() {
        location.source_line = source
          .lines()
          .nth(location.line.saturating_sub(1))
          .map(str::to_string);
      }
    };
    add(&mut self.location);
    for reference in &mut self.references {
      add(&mut reference.location);
    }
  }
}

fn write_location(
  f: &mut fmt::Formatter<'_>,
  prefix: &str,
  location: &SourceLocation,
) -> fmt::Result {
  write!(
    f,
    "    {} {}:{}:{}",
    prefix, location.file, location.line, location.character
  )?;
  if let Some(source_line) = &location.source_line {
    let gutter = location.line.to_string();
    write!(
      f,
      "\n      {} | {}\n      {} | {}^",
      gutter,
      source_line,
      " ".repeat(gutter.len()),
      " ".repeat(location.character.saturating_sub(1))
    )?;
  }
  Ok(())
}

impl fmt::Display for ConfTSError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    writeln!(f, "ConfTSError: {}", self.message)?;
    write_location(f, "at", &self.location)?;
    for reference in &self.references {
      writeln!(f)?;
      write_location(f, &reference.label, &reference.location)?;
    }
    if !self.suggestions.is_empty() {
      write!(f, "\n\n    Suggested fixes:")?;
      for (index, suggestion) in self.suggestions.iter().enumerate() {
        write!(f, "\n      {}. {}", index + 1, suggestion)?;
      }
    }
    Ok(())
  }
}

impl std::error::Error for ConfTSError {}
