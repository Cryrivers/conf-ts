use std::fmt;

/// Source location for error reporting.
#[derive(Debug, Clone)]
pub struct SourceLocation {
  pub file: String,
  pub line: usize,
  pub character: usize,
}

/// The main error type, mirrors ConfTSError from the TS version.
#[derive(Debug, Clone)]
pub struct ConfTSError {
  pub message: String,
  pub location: SourceLocation,
}

impl ConfTSError {
  pub fn new(
    message: impl Into<String>,
    file: impl Into<String>,
    line: usize,
    character: usize,
  ) -> Self {
    Self {
      message: message.into(),
      location: SourceLocation {
        file: file.into(),
        line,
        character,
      },
    }
  }
}

impl fmt::Display for ConfTSError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(
      f,
      "ConfTSError: {}\n    at {}:{}:{}",
      self.message, self.location.file, self.location.line, self.location.character
    )
  }
}

impl std::error::Error for ConfTSError {}
