# Error reference

conf-ts errors are precise: they name the file, line, column, the source line
itself, and every `referenced from <file>:<line>:<col>` hop in the re-export
chain that reached the failure, followed by a `Suggested fixes:` section. Read
the whole diagnostic before editing — the failure is usually in an imported file,
not the entry.

The TypeScript and native compilers report the same information; the native one
formats it into the `Error.message` instead of a `ConfTSError` instance.

## Compiler (plain mode)

| Message                                                                                                     | Cause                                                      | Fix                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `No default export found in the entry file`                                                                 | Entry only has named exports                               | Add `export default`, `export { x as default }`, or `export { default } from` |
| `Unsupported type: Function`                                                                                | An arrow/`function` value in the config                    | Move the logic out, or express it with `expr()` in macro mode                 |
| `Unsupported type: Date`                                                                                    | `new Date()` (or any `new` expression)                     | Use an ISO date string or a numeric timestamp                                 |
| `Unsupported type: RegExp`                                                                                  | A regex literal                                            | Store the pattern as a string and compile it at runtime                       |
| `Failed to evaluate variable "c". Only 'const' declarations are supported, but it was declared with 'let'.` | A referenced `let`/`var`                                   | Change it to `const`                                                          |
| `Non-null assertion failed: value is null or undefined`                                                     | `x!` where `x` really is nullish at compile time           | Provide a value, or use `?? fallback`                                         |
| `Non-null assertion applied to value typed as 'null' or 'undefined'`                                        | `x!` where the declared type is exactly `null`/`undefined` | Widen the type or drop the assertion                                          |
| `Failed to parse file:`                                                                                     | Syntax error                                               | The diagnostic prints the offending line — check for a missing or extra comma |

## Macro mode

| Message                                                                                       | Cause                                                                                                   | Fix                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Unsupported call expression: arrayMap` / `Function "arrayMap" is only allowed in macro mode` | `arrayMap`/`arrayFilter`/`arrayFlatMap` callback isn't a single-parameter arrow with an expression body | Rewrite the callback as `x => expr`                                                                       |
| `String` / `Boolean` reported as an unevaluatable call                                        | The macro wasn't imported from `@conf-ts/macro`, or the file is being compiled in plain mode            | Add the import; if the build compiles this file without macro mode, rewrite the value in plain TypeScript |
| `'<name>' is a compile-time macro from '@conf-ts/macro' … it cannot run at runtime.`          | The macro reached runtime unexpanded                                                                    | The transform never ran — the file is outside macro mode, or it was imported by application code          |

The two macro-mode symptoms that look confusing:

- A **shadowed** macro name (`const String = ...`) is left entirely untouched by
  the transform — the failure appears later, in the compiler.
- A macro call the transformer **cannot** rewrite is left in place together with
  its import, so `@conf-ts/macro` still appears in the output. A fully
  transformed file has no `from '@conf-ts/macro'` left.

## `modifier()`

| Message                                                                                    | Cause                                                                | Fix                                                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `modifier callback must be a synchronous arrow function whose body is a single expression` | The callback is async, a function expression, or has a block body    | Use `(...args) => expression`                                      |
| `modifier arguments must be statically analyzable`                                         | An invocation argument depends on a runtime value                    | Pass literals, enums, or local/imported `const` values             |
| `modifier expected at least N static argument(s), but received M`                          | A required argument was omitted                                      | Pass it, or make the parameter optional/defaulted                  |
| `modifier expected at most N static argument(s), but received M`                           | Too many arguments were passed without a rest parameter              | Remove extras, or add a trailing rest parameter                    |
| `modifier parameters must be identifiers…`                                                 | A parameter uses a nested/computed pattern or invalid rest placement | Use identifiers or one level of object/array destructuring         |
| `modifier cannot destructure null or undefined`                                            | A destructured argument resolved to a nullish value                  | Pass an object/array, or default the parameter                     |
| `modifier array destructuring requires a statically analyzable array or string`            | Array destructuring received another static type                     | Pass a static array/string                                         |
| `modifier aliases must use const declarations`                                             | A modifier was assigned through `let`/`var`                          | Change the alias to `const`                                        |
| `modifier values are compile-time-only`                                                    | The modifier function escaped into generated data                    | Invoke it, or forward it only through const/import/export bindings |

## `expr()`

All structural rejections share one message:
`Unsupported call expression: expr` (TypeScript) /
`Function "expr" is only allowed in macro mode` (native).

Triggers:

- Block body: `expr(ctx => { return ctx.a; })`
- `function` expression: `expr(function (ctx) { return ctx.a; })`
- `async` arrow: `expr(async ctx => ctx.a)`
- Direct context use: `expr(ctx => ctx)`
- Syntax outside the runtime grammar: `expr(ctx => (ctx.a = 2))`
- `expr` not imported from `@conf-ts/macro`
- A macro call inside `expr()` referencing an identifier that is neither a
  constant nor sourced from the context
- A cast macro called with the wrong arity: `String(ctx.a, 'extra')`
- A nested callback whose parameter **shadows** the context parameter or an
  enclosing callback's binding: `ctx.queue.filter(ctx => ctx < 5)`
- A nested callback with a multi-statement block body
- An `async` nested callback

Specific messages:

| Message                                                                                                                       | Fix                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Nested Expr 'subExpr' must be called with exactly one argument: the current expr context parameter 'ctx'.`                   | Call it as `subExpr(ctx)` with the bare parameter — not a property, another value, zero args, multiple args, or a spread |
| `Nested Expr 'always' must be called with no arguments because the enclosing expr callback doesn't take a context parameter.` | Drop the argument: `always()`                                                                                            |

## `exprTemplate()`

| Message                                                                                                            | Cause                                                                           | Fix                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `exprTemplate callback must be a synchronous arrow function whose first parameter is a plain context identifier`   | The context parameter was destructured or the callback isn't a plain sync arrow | Use `(ctx, ...) => ...`                                      |
| `exprTemplate arguments must be statically analyzable` (native: `Unsupported variable type for identifier: value`) | An argument came from a runtime value                                           | Pass a literal, enum, or `const`                             |
| `exprTemplate expected at least N static argument(s), but received M`                                              | A required parameter was omitted                                                | Pass it, or make the parameter optional/defaulted            |
| `exprTemplate expected at most N static argument(s), but received M`                                               | Too many arguments were passed and no rest parameter accepts them               | Remove extras, or add a trailing rest parameter              |
| `exprTemplate cannot destructure null or undefined`                                                                | A destructured argument resolved to a nullish value                             | Pass an object/array, or default the destructured parameter  |
| `exprTemplate array destructuring requires a statically analyzable array or string`                                | Array destructuring received another static type                                | Pass a static array/string                                   |
| `exprTemplate values are compile-time-only`                                                                        | The template escaped into runtime data (`[add]`) or was called dynamically      | Instantiate it at the call site instead of passing it around |

Enabling `pruneExprTemplate` does not introduce a separate error category. If a
ternary condition cannot be decided safely, the transformer leaves it intact.
Any error from specializing the selected branch still uses the standard
location, source line, reference chain, and `Suggested fixes:` diagnostics; an
unselected branch is not evaluated.

## Suggested fixes

Every diagnostic ends with a `Suggested fixes:` section written for the specific
failure — `Replace \`new Date(...)\` with an ISO date string or a numeric
timestamp.`, `Rename the nested callback parameter so it differs from the outer
expression context, for example \`item => item < 5\`.`, and so on. Apply it
before improvising a workaround; it is derived from the same rule that rejected
the code.
