## @conf-ts/expression

A JavaScript-like runtime expression evaluator. It turns a serialized expression string — typically emitted by `expr()` from [`@conf-ts/macro`](../macro) — into a reusable function that evaluates against a plain data object, or passes a callback-form `Expr` value straight through so its closure keeps working.

## Installation

```bash
pnpm add @conf-ts/expression
```

## Usage

```ts
import expression from '@conf-ts/expression';

const calculate = expression('subtotal * (1 + taxRate)');

calculate({ subtotal: 100, taxRate: 0.08 }); // 108
```

Pass `expression(source, { optionalMemberAccess: true })` (or the equivalent `{ loose: true }` alias) to make non-optional property access behave like optional member access: `a.b.c` acts like `a?.b?.c` and returns `undefined` if the chain crosses `null` or `undefined`. Calls are not made optional this way: an interrupted callee chain such as `a.b.c()` returns `undefined`, but calling an existing property whose value is `undefined` still throws a non-callable error. Callback-form `Expr` values ignore this option.

Parsed string expressions are cached in a 1,000-entry LRU cache keyed by source and option mode, so parsing the same source repeatedly returns the same function. Callback expressions preserve their original identity. The package's public API is intentionally evaluation-only — it exports the default `expression()` function and evaluation-facing TypeScript types. Tooling that needs lexer/parser primitives should import [`@conf-ts/expr-core`](../expr-core) instead.

`LooseExpr<Context, ReturnType>` is a type-only counterpart to `Expr<Context, ReturnType>` for `Context` types with nested optional properties, letting an `expr()` callback body skip `?.` at every level while `@conf-ts/expression` still enforces `optionalMemberAccess`/`loose: true` at evaluation time. See the [root README](../../../README.md#runtime-expression-evaluator) for the full type-level explanation.

## Supported syntax

| Category    | Supported syntax                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literals    | Decimal numbers (including exponent notation), strings, booleans, `null`, `undefined`                                                                                                                                        |
| Collections | Array literals (including holes); object literals with identifier/string keys, trailing commas, and object spread                                                                                                            |
| Access      | Identifiers, `object.property`, `object[key]`, optional member access (`object?.property`, `object?.[key]`)                                                                                                                  |
| Calls       | Functions and methods supplied by the environment; method calls preserve `this`; optional calls (`fn?.()`)                                                                                                                   |
| Functions   | Arrow function expressions (`x => x * 2`, `(a, b) => a + b`) passed as callback arguments — expression bodies only, with identifier/destructured/rest/defaulted parameters, nesting, and closures over the surrounding scope |
| Templates   | Template literals, nested interpolation, and tagged templates                                                                                                                                                                |
| Arithmetic  | `+`, `-`, `*`, `/`, `%`, `**`                                                                                                                                                                                                |
| Comparison  | `<`, `<=`, `>`, `>=`, `==`, `!=`, `===`, `!==`, `in`, `instanceof`                                                                                                                                                           |
| Bitwise     | `&`, `\|`, `^`, `~`, `<<`, `>>`, `>>>`                                                                                                                                                                                       |
| Logical     | `!`, `&&`, `\|\|`, `??` with short-circuit evaluation                                                                                                                                                                        |
| Unary       | Unary `+`/`-`, `typeof`, `void`, `delete`                                                                                                                                                                                    |
| Control     | Parentheses and conditional expressions (`condition ? yes : no`)                                                                                                                                                             |

The parser applies JavaScript-style precedence to the supported operators, including right-associative exponentiation.

Not supported: assignments, `++`/`--`, array spread, object shorthand/computed keys, block-bodied statements (arrow functions are limited to expression bodies), `new`, classes, regular expressions, or comments.

## Semantics and safety

Within the supported grammar, serialized expressions follow JavaScript semantics:

- Missing properties evaluate to `undefined`; non-optional access through `null` or `undefined` throws (unless `optionalMemberAccess`/`loose` is set).
- Accessor, Proxy, non-callable, and invoked-function errors propagate.
- Environment and global-builtin lookups (`String`/`Number`/`Boolean`) are resolved by **own property only**, never via the prototype chain, so a compiled or hand-written expression can't reach `constructor`/`toString`/other `Object.prototype` members to escape the sandboxed data it was given.
- Errors from runtime callbacks and serialized compiler output are expected to agree by error type and timing; engine-specific message text is not part of the contract.

This package is an evaluator, not a full security sandbox on its own: expressions can still read objects and invoke functions exposed through the environment. Do not expose capabilities that untrusted expressions must not access.

## Comparison with `expr-parser`

[`expr-parser`](https://github.com/JuneAndGreen/expr-parser) is another small JS expression parser/evaluator for a similar niche (embedding expression strings in config/rule data). The two libraries take different positions on grammar coverage, null-safety, and sandboxing:

| Capability                                      | `@conf-ts/expression`                                                                                                                             | `expr-parser`                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Number literals                                 | ✅ decimal, exponent (`2e3`, `2e-3`)                                                                                                              | ✅ decimal, exponent (`2e3`, `2e-3`)                                                            |
| String escapes                                  | ✅ `\n \r \t \f \v`, `\uXXXX` unicode                                                                                                             | ✅ `\n \r \t \f \v`, `\uXXXX` unicode                                                           |
| Template literals / tagged templates            | ✅ full support, including nested interpolation                                                                                                   | ❌ not supported                                                                                |
| Array literals                                  | ✅ including holes (`[1, , 2]`)                                                                                                                   | ⚠️ trailing comma only, no holes                                                                |
| Object literals                                 | ✅ identifier/string keys, spread (`...obj`)                                                                                                      | ⚠️ identifier/string/number keys, no spread, no shorthand, no computed keys                     |
| Array spread / object shorthand / computed keys | ❌ not supported                                                                                                                                  | ❌ not supported                                                                                |
| Member access (`a.b`, `a[b]`)                   | ✅                                                                                                                                                | ✅ (implemented as a single dotted-path getter internally, same observable result)              |
| Optional chaining (`?.`, `?.[]`, `?.()`)        | ✅ real optional-chaining operators, short-circuits the whole chain                                                                               | ❌ no operator — but _every_ `.`/`[]` access is unconditionally null-safe instead               |
| Strict (throwing) property access               | ✅ default behavior matches plain JS (`a.b.c` throws through `null`)                                                                              | ❌ never throws on `null`/`undefined` member access — no way to opt into strict mode            |
| Function/method calls, `this` binding           | ✅                                                                                                                                                | ✅                                                                                              |
| Call/argument spread                            | ❌ not supported                                                                                                                                  | ❌ not supported                                                                                |
| Inline callback/arrow functions as arguments    | ✅ expression-bodied arrows, destructuring, rest/default params, nesting/currying, closures                                                       | ❌ cannot author a function inline — can only call a function value already present in the data |
| Arithmetic                                      | ✅ `+ - * / % **`                                                                                                                                 | ⚠️ `+ - * / %` — no exponentiation (`**`)                                                       |
| Comparison                                      | ✅ `< <= > >= == != === !==`, plus `in`, `instanceof`                                                                                             | ⚠️ `< <= > >= == != === !==` only — no `in`, no `instanceof`                                    |
| Bitwise operators                               | ✅ `& \| ^ ~ << >> >>>`                                                                                                                           | ❌ not supported                                                                                |
| Logical operators                               | ✅ `&& \|\| ??` with short-circuit                                                                                                                | ⚠️ `&& \|                                                                                       | ` only — no nullish coalescing (`??`) |
| Unary operators                                 | ✅ `+ - ! ~ typeof void delete`                                                                                                                   | ⚠️ `+ - !` only — no `typeof`, `void`, `delete`, `~`                                            |
| Ternary / parentheses                           | ✅                                                                                                                                                | ✅                                                                                              |
| Sequence/comma expressions                      | ❌ not supported                                                                                                                                  | ❌ not supported                                                                                |
| `new`, classes, regular expressions, comments   | ❌ not supported                                                                                                                                  | ❌ not supported                                                                                |
| Own-property-only environment lookup            | ✅ blocks reads of inherited `Object.prototype` members (e.g. `constructor`)                                                                      | ❌ plain property lookup walks the prototype chain like ordinary JS property access             |
| Parsed-expression caching                       | ✅ built-in 1,000-entry LRU cache keyed by source + option mode                                                                                   | ❌ every `new Expression(str).parse()` call re-lexes and re-parses                              |
| TypeScript types                                | ✅ written in TypeScript; typed `Expr<Context, ReturnType>` / `LooseExpr<Context, ReturnType>`                                                    | ❌ plain JS, no published type definitions                                                      |
| Typed compile-time authoring companion          | ✅ `expr()` from `@conf-ts/macro` compiles real, type-checked TypeScript callbacks (including nested callbacks) down to this exact string grammar | ❌ expressions are always authored and validated as raw strings                                 |

In short: `expr-parser` is a compact ES5-era expression parser with an "always null-safe" access model, while `@conf-ts/expression` targets closer parity with modern JavaScript expression syntax (bitwise/nullish/exponent operators, template literals, optional chaining, arrow-function callback arguments), opt-in rather than unconditional null-safety, an explicit prototype-pollution guard, built-in caching, and first-class TypeScript types with a typed authoring path via `@conf-ts/macro`'s `expr()`.

## License

MIT
