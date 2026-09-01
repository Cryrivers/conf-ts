## @conf-ts/expression

A JavaScript-like runtime expression evaluator and ahead-of-time compiler. It turns a serialized expression string — typically emitted by `expr()` from [`@conf-ts/macro`](../macro) — into a reusable function that evaluates against a plain data object.

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

Pass `expression(source, { optionalMemberAccess: true })` (or the equivalent `{ loose: true }` alias) to make non-optional property access behave like optional member access: `a.b.c` acts like `a?.b?.c` and returns `undefined` if the chain crosses `null` or `undefined`. Calls are not made optional this way: an interrupted callee chain such as `a.b.c()` returns `undefined`, but calling an existing property whose value is `undefined` still throws a non-callable error.

Interpreted and successfully compiled expressions use separate 1,000-entry LRU caches keyed by source and option mode, so asking for the same path repeatedly returns the same function. A CSP fallback is intentionally not cached, allowing a later call to compile after policy or runtime conditions change. Tooling that needs lexer/parser primitives should import [`@conf-ts/expr-core`](../expr-core) instead.

`LooseExpr<Context, ReturnType>` is a type-only counterpart to `Expr<Context, ReturnType>` for `Context` types with nested optional properties, letting an `expr()` callback body skip `?.` at every level while `@conf-ts/expression` still enforces `optionalMemberAccess`/`loose: true` at evaluation time. See the [root README](../../../README.md#runtime-expression-evaluator) for the full type-level explanation.

## Ahead-of-time compilation

`compile()` walks the parsed AST once and emits a specialized JavaScript function. The generated code removes the interpreter's per-node dispatch on hot evaluation paths while preserving the same expression semantics.

```ts
import { compile } from '@conf-ts/expression';

const calculate = compile('subtotal * (1 + taxRate)', { strict: true });

calculate({ subtotal: 100, taxRate: 0.08 }); // 108
```

Compilation is explicit because it uses `new Function`. If the runtime or Content Security Policy rejects dynamic code generation, `compile(source)` returns an interpreter-backed function. Pass `{ strict: true }` to throw `ExpressionCompileError` instead, which is useful for tests and for confirming that a known hot path really compiled.

The compiler never evaluates or interpolates the raw source as JavaScript. It parses with `@conf-ts/expr-core`, emits only whitelisted operators and generated variable names, JSON-encodes every source-derived string, and keeps root identifier resolution behind the same own-property-only lookup as the interpreter. The expression can still use capabilities deliberately supplied through its environment; neither execution mode is a complete security sandbox.

Compile only reusable hot expressions. Parsing plus code generation costs more than building an interpreter closure, so one-off evaluations do not amortize the cold-start cost.

## Supported syntax

| Category    | Supported syntax                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literals    | Decimal numbers (including exponent notation), strings, booleans, `null`, `undefined`                                                                                                                                        |
| Collections | Array literals (including holes and spread elements, e.g. `[...a, b]`); object literals with identifier/string/computed (`{ [key]: value }`) keys, shorthand properties (`{ a, b }`), trailing commas, and object spread     |
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

Not supported: assignments, `++`/`--`, block-bodied statements (arrow functions are limited to expression bodies), `new`, classes, regular expressions, or comments.

## Semantics and safety

Within the supported grammar, serialized expressions follow JavaScript semantics:

- Missing properties evaluate to `undefined`; non-optional access through `null` or `undefined` throws (unless `optionalMemberAccess`/`loose` is set).
- Accessor, Proxy, non-callable, and invoked-function errors propagate.
- Environment and global-builtin lookups (`String`/`Number`/`Boolean`) are resolved by **own property only**, never via the prototype chain, so a compiled or hand-written expression can't reach `constructor`/`toString`/other `Object.prototype` members to escape the sandboxed data it was given.
- A computed object key (`{ [expr]: value }`) coerces its key the same way computed member access does: a `symbol` value is used as-is, anything else is coerced via `String(...)`.
- Array spread (`[...a, b]`) consumes `a` through its iterator protocol like native `[...a]`, so a non-iterable or nullish source throws `TypeError`. Object spread (`{ ...a }`) instead copies `a`'s own enumerable properties and silently no-ops for a non-object/nullish source, matching native `{...a}`.
- Errors from runtime callbacks and serialized compiler output are expected to agree by error type and timing; engine-specific message text is not part of the contract.

This package is an evaluator, not a full security sandbox on its own: expressions can still read objects and invoke functions exposed through the environment. Do not expose capabilities that untrusted expressions must not access.

## Benchmark

Run the reproducible benchmark with:

```bash
pnpm --filter @conf-ts/expression bench
```

The benchmark checks result parity first, warms both paths, interleaves interpreter and compiler measurements, and retains the best of eight rounds to reduce scheduler and thermal noise. A representative run on Node 24.18.0, macOS arm64:

| Case                               | Interpreter |    Compiled | Speedup |
| ---------------------------------- | ----------: | ----------: | ------: |
| Arithmetic                         | 118.8 ns/op |  46.1 ns/op |   2.58x |
| Deep member access                 | 244.6 ns/op |  81.7 ns/op |   2.99x |
| Wide expression (20 values)        | 795.2 ns/op | 323.2 ns/op |   2.46x |
| `filter`/`map`/`reduce` callbacks  | 10.72 µs/op |  1.88 µs/op |   5.70x |
| Object/array/template construction | 541.2 ns/op | 416.8 ns/op |   1.30x |

Cold construction was about 1.35 µs per interpreter closure versus 9.08 µs per generated function in the same run. Absolute timings vary by machine; the benchmark script is the source of truth.

### Memory benchmark

Run the memory benchmark separately:

```bash
pnpm --filter @conf-ts/expression bench:memory
```

Every retained-memory sample runs in a fresh `--expose-gc` process, starts from an equally warmed baseline, creates and retains 1,000 unique expressions, forces several full GC passes, and takes snapshots both before and after evaluating each function once. The following is a representative median-of-seven run on the same Node 24.18.0 macOS arm64 machine:

| Mode        | Heap after construction | Heap after first evaluation | Heap ratio | V8 code + metadata | V8 bytecode + metadata | RSS delta | Peak construction heap |
| ----------- | ----------------------: | --------------------------: | ---------: | -----------------: | ---------------------: | --------: | ---------------------: |
| Interpreter |              655 B/expr |                  683 B/expr |      1.00x |         129 B/expr |               0 B/expr |  6.00 MiB |               1.87 MiB |
| Compiled    |           1.00 KiB/expr |               1.29 KiB/expr |      1.93x |         126 B/expr |             168 B/expr |  5.17 MiB |               2.35 MiB |

The script also estimates temporary heap allocation over 1,000 hot `filter`/`map`/`reduce` evaluations without forcing GC inside the measured batch. The median was 522 B/evaluation for the interpreter and 804 B/evaluation for compiled code (1.54x). This is allocation churn, not retained memory; in the CPU benchmark the same callback-heavy case was about 5.7x faster when compiled.

Treat RSS as page-granular process noise, especially for deltas this small. V8's code and bytecode counters overlap process/heap memory, so they are diagnostic columns and must not be added to heap or RSS. Absolute values depend on the Node/V8 build; rerun the script on the deployment runtime when memory limits matter.

## Comparison with `expr-parser`

[`expr-parser`](https://github.com/JuneAndGreen/expr-parser) is another small JS expression parser/evaluator for a similar niche (embedding expression strings in config/rule data). The two libraries take different positions on grammar coverage, null-safety, and sandboxing:

| Capability                                    | `@conf-ts/expression`                                                                                                                             | `expr-parser`                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Number literals                               | ✅ decimal, exponent (`2e3`, `2e-3`)                                                                                                              | ✅ decimal, exponent (`2e3`, `2e-3`)                                                            |
| String escapes                                | ✅ `\n \r \t \f \v`, `\uXXXX` unicode                                                                                                             | ✅ `\n \r \t \f \v`, `\uXXXX` unicode                                                           |
| Template literals / tagged templates          | ✅ full support, including nested interpolation                                                                                                   | ❌ not supported                                                                                |
| Array literals                                | ✅ including holes (`[1, , 2]`) and spread (`[...a, b]`)                                                                                          | ⚠️ trailing comma only, no holes, no spread                                                     |
| Object literals                               | ✅ identifier/string/computed (`{ [k]: v }`) keys, shorthand (`{ a }`), spread (`...obj`)                                                         | ⚠️ identifier/string/number keys, no spread, no shorthand, no computed keys                     |
| Member access (`a.b`, `a[b]`)                 | ✅                                                                                                                                                | ✅ (implemented as a single dotted-path getter internally, same observable result)              |
| Optional chaining (`?.`, `?.[]`, `?.()`)      | ✅ real optional-chaining operators, short-circuits the whole chain                                                                               | ❌ no operator — but _every_ `.`/`[]` access is unconditionally null-safe instead               |
| Strict (throwing) property access             | ✅ default behavior matches plain JS (`a.b.c` throws through `null`)                                                                              | ❌ never throws on `null`/`undefined` member access — no way to opt into strict mode            |
| Function/method calls, `this` binding         | ✅                                                                                                                                                | ✅                                                                                              |
| Call/argument spread                          | ❌ not supported                                                                                                                                  | ❌ not supported                                                                                |
| Inline callback/arrow functions as arguments  | ✅ expression-bodied arrows, destructuring, rest/default params, nesting/currying, closures                                                       | ❌ cannot author a function inline — can only call a function value already present in the data |
| Arithmetic                                    | ✅ `+ - * / % **`                                                                                                                                 | ⚠️ `+ - * / %` — no exponentiation (`**`)                                                       |
| Comparison                                    | ✅ `< <= > >= == != === !==`, plus `in`, `instanceof`                                                                                             | ⚠️ `< <= > >= == != === !==` only — no `in`, no `instanceof`                                    |
| Bitwise operators                             | ✅ `& \| ^ ~ << >> >>>`                                                                                                                           | ❌ not supported                                                                                |
| Logical operators                             | ✅ `&& \|\| ??` with short-circuit                                                                                                                | ⚠️ `&& \|                                                                                       | ` only — no nullish coalescing (`??`) |
| Unary operators                               | ✅ `+ - ! ~ typeof void delete`                                                                                                                   | ⚠️ `+ - !` only — no `typeof`, `void`, `delete`, `~`                                            |
| Ternary / parentheses                         | ✅                                                                                                                                                | ✅                                                                                              |
| Sequence/comma expressions                    | ❌ not supported                                                                                                                                  | ❌ not supported                                                                                |
| `new`, classes, regular expressions, comments | ❌ not supported                                                                                                                                  | ❌ not supported                                                                                |
| Own-property-only environment lookup          | ✅ blocks reads of inherited `Object.prototype` members (e.g. `constructor`)                                                                      | ❌ plain property lookup walks the prototype chain like ordinary JS property access             |
| Parsed-expression caching                     | ✅ built-in 1,000-entry LRU cache keyed by source + option mode                                                                                   | ❌ every `new Expression(str).parse()` call re-lexes and re-parses                              |
| TypeScript types                              | ✅ written in TypeScript; typed `Expr<Context, ReturnType>` / `LooseExpr<Context, ReturnType>`                                                    | ❌ plain JS, no published type definitions                                                      |
| Typed compile-time authoring companion        | ✅ `expr()` from `@conf-ts/macro` compiles real, type-checked TypeScript callbacks (including nested callbacks) down to this exact string grammar | ❌ expressions are always authored and validated as raw strings                                 |

In short: `expr-parser` is a compact ES5-era expression parser with an "always null-safe" access model, while `@conf-ts/expression` targets closer parity with modern JavaScript expression syntax (bitwise/nullish/exponent operators, template literals, optional chaining, arrow-function callback arguments, array/object spread, shorthand and computed object properties), opt-in rather than unconditional null-safety, an explicit prototype-pollution guard, built-in caching, and first-class TypeScript types with a typed authoring path via `@conf-ts/macro`'s `expr()`.

## License

MIT
