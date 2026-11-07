// `@conf-ts/expression/core`: the lexer, parser, printer, AST utilities, and
// types of @conf-ts/expr-core, for tooling that only depends on this package.
// Re-exporting (rather than copying) keeps them the very module this package
// evaluates with, so ASTs and `instanceof ExprSyntaxError` checks agree.
export * from '@conf-ts/expr-core';
