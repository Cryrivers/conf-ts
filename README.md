## conf-ts

Compile TypeScript-based configs to JSON or YAML. Keep configs type-safe, composable, and multi-file — then emit plain data for production.

### Try it now

- **Playground**: [conf-ts.by.zhongliang.wang](https://conf-ts.by.zhongliang.wang)

## Why conf-ts

- **Type-safe configs**: Author in TypeScript with enums, constants, spreads, and expressions.
- **Deterministic output**: Produces JSON/YAML with no runtime TypeScript.
- **Macro transform (opt-in)**: Compile-time helpers for casting, array transforms, env injection, and typed runtime expressions.
- **Multi-file + path aliases**: Works across files and honors `tsconfig.json` path aliases.

## Packages in this monorepo

- `@conf-ts/cli`: CLI to compile `.ts`/`.conf.ts` to JSON/YAML
- `@conf-ts/compiler`: Core compiler APIs (`compile`, `compileInMemory`)
- `@conf-ts/compiler-native`: Native Rust compiler with Node bindings (same API as `@conf-ts/compiler`)
- `@conf-ts/expr-core`: Shared expression lexer, parser, AST types, and parse errors
- `@conf-ts/expression`: JavaScript-like runtime expression evaluator
- `@conf-ts/macro`: Macro functions consumed by the transform
- `@conf-ts/macro-transformer`: TypeScript source transformer for macros
- `@conf-ts/macro-transformer-native`: Oxc-backed native source transformer
- `@conf-ts/webpack-plugin`: Webpack plugin that emits generated JSON/YAML files

### Performance: JS vs compiler-native

Benchmarked with `@conf-ts/tests` on `complex-types.conf.ts` (2s per task, Node v24.11.1, local M-series Mac).

```text
┌─────────┬──────────────────────────┬────────────────────┬──────────────────────┬────────────────────────┬────────────────────────┬─────────┐
│ (index) │ Task name                │ Latency avg (ns)   │ Latency med (ns)     │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├─────────┼──────────────────────────┼────────────────────┼──────────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0       │ compiler (JS)            │ 97685109 ± 1.27%   │ 95375041 ± 1973083   │ 10 ± 1.20%             │ 10 ± 0                 │ 64      │
│ 1       │ compiler-native (Rust)   │ 42164 ± 1.09%      │ 38750 ± 791.00       │ 24616 ± 0.10%          │ 25806 ± 538            │ 47434   │
└─────────┴──────────────────────────┴────────────────────┴──────────────────────┴────────────────────────┴────────────────────────┴─────────┘
```

In this setup, **`@conf-ts/compiler-native` achieves roughly 2,400× higher throughput** than the pure JS compiler on the same config file.

## Installation

```bash
pnpm add -D @conf-ts/cli
# or
npm i -D @conf-ts/cli
# or
yarn add -D @conf-ts/cli
```

## CLI usage

```bash
conf-ts <fileEntry>

# JSON (default)
conf-ts src/config.conf.ts

# YAML
conf-ts -f yaml src/config.conf.ts

# Macro transform
conf-ts --macro src/config.conf.ts

# Single-quoted expr macro output
conf-ts --macro --quote single src/config.conf.ts
```

The compiled output is printed to stdout.

## Macro transform

Enable with `--macro`. All macros must be imported from `@conf-ts/macro`.

### Type casting: `String()`, `Number()`, `Boolean()`

```ts
import { Boolean, Number, String } from '@conf-ts/macro';

export default {
  asString: String(123), // "123"
  asNumber: Number('1'), // 1
  asBoolean: Boolean(0), // false
};
```

### Arrays: `arrayMap(array, item => expr)`

Constraints:

- Callback must be an arrow function with exactly one parameter
- Body must be a single return expression (or expression body)
- The callback parameter can be used in property access chains (e.g., `item.name`) and object keys (e.g., `{ [item.id]: item.value }`).

```ts
import { arrayMap } from '@conf-ts/macro';

const nums = [1, 2, 3, 4];
export default {
  doubled: arrayMap(nums, x => x * 2),
};
```

### Arrays: `arrayFilter(array, item => predicate)`

Constraints:

- Callback must be an arrow function with exactly one parameter
- Body must be a single return expression (or expression body)
- The callback parameter can be used in property access chains (e.g., `item.name`) and object keys (e.g., `{ [item.id]: item.value }`).
- The returned expression is coerced to boolean to decide inclusion

```ts
import { arrayFilter } from '@conf-ts/macro';

const nums = [1, 2, 3, 4];
export default {
  evens: arrayFilter(nums, x => x % 2 === 0),
};
```

### Arrays: `arrayFlatMap(array, item => expr)`

Constraints:

- Callback must be an arrow function with exactly one parameter
- Body must be a single return expression (or expression body)
- The callback parameter can be used in property access chains (e.g., `item.name`) and object keys (e.g., `{ [item.id]: item.value }`).
- Array results are flattened by one level; non-array results are kept as single items

```ts
import { arrayFlatMap } from '@conf-ts/macro';

const nums = [1, 2, 3];
export default {
  expanded: arrayFlatMap(nums, x => [x, x * 10]),
};
```

### Environment: `env(key)`

```ts
import { env } from '@conf-ts/macro';

export default {
  nodeEnv: env('NODE_ENV'),
  port: Number(env('PORT') ?? '3000'),
};
```

### Type-safe runtime expressions: `expr(ctx => expression)`

`expr()` marks a typed arrow expression for configuration compilation. During normal runtime execution it preserves and returns the callback, including its closure. During JSON/YAML compilation it emits a portable expression string: accesses to the callback parameter become root identifiers, and serializable `const` and enum values are resolved.

Generated expression strings are compact: formatting newlines, tabs, and repeated spaces are collapsed to a single space without changing whitespace inside string or template literal values. String literals use double quotes by default. Set macro transform option `quote: 'single'` or CLI `--quote single` to emit single-quoted expression literals instead. The TypeScript and native Oxc transformers normalize expression string literals with the same encoder so their output stays byte-for-byte aligned.

```ts
import { expr } from '@conf-ts/macro';

enum Status {
  Active = 'active',
}

const MIN_AGE = 18;

type UserContext = {
  user: { age: number; status: Status };
};

export default {
  canEnter: expr<UserContext, boolean>(
    ctx => ctx.user.age >= MIN_AGE && ctx.user.status === Status.Active,
  ),
};
```

The generated value is a portable expression string:

```json
{
  "canEnter": "user.age >= 18 && user.status === \"active\""
}
```

Evaluate it against runtime data:

```ts
import expression from '@conf-ts/expression';

import config from './config.generated.json';

const canEnter = expression(config.canEnter);

canEnter({ user: { age: 20, status: 'active' } }); // true
canEnter({ user: { age: 16, status: 'active' } }); // false
```

Constraints:

- The callback must be a synchronous arrow function with exactly one identifier parameter and an expression body.
- Root context access must use a property name, such as `ctx.user` or `ctx['user']`. Direct `ctx` use is rejected. A computed root key such as `ctx[key]` must resolve to a valid identifier name when compiled.
- Nested access, calls, templates, object/array literals, and the operators listed in [Runtime expression syntax](#runtime-expression-syntax) are supported.
- Assignment, update, function/arrow, `new`, regular expression, and other syntax outside that grammar is rejected during compilation.

Compiled `Expr` values can be composed by calling them with the current
callback context. The transformer recursively inlines the compiled expression
and adds parentheses to preserve operator precedence:

```ts
import { expr } from '@conf-ts/macro';

type Context = { a: boolean; b: boolean; c: boolean };

const subCondExpr = expr<Context, boolean>(ctx => ctx.b || ctx.c);
const condition = expr<Context, boolean>(ctx => ctx.a && subCondExpr(ctx)); // "a && (b || c)"
```

Composition supports local `const` aliases and directly named/default imported
Expr values, at any nesting depth. The argument must be the current callback's
bare parameter identifier (the identifier does not have to be named `ctx`). A
confirmed Expr called with a property, another value, no argument, multiple
arguments, or a spread argument is rejected during transformation. Namespace
properties, function-returned Expr values, and re-export chains are not
resolved as composed Expr sources.

### Nested macros

Macros can be nested inside other macros and within array callbacks. Context (the callback parameter) is correctly scoped during nested evaluation.

```ts
import {
  arrayFilter,
  arrayFlatMap,
  arrayMap,
  Boolean,
  Number,
  String,
} from '@conf-ts/macro';

const users = [{ id: 1 }, { id: 2 }, { id: 3 }];
const nums = [0, 1, 2];

export default {
  // Macro inside arrayMap callback, parameter is correctly passed
  idStrings: arrayMap(users, u => String(u.id)), // ["1","2","3"]

  // Nested casting chain
  roundTrip: Number(String(42)), // 42

  // Multi-layer nesting inside callback
  truthyFlags: arrayMap(nums, n => Boolean(Number(String(n)))), // [false, true, true]

  // Nested array macros in arguments + callback macro
  filteredThenString: arrayMap(
    arrayFilter(nums, n => Boolean(n)),
    m => String(m),
  ), // ["1","2"]

  // Flat-map arrays by one level
  expanded: arrayFlatMap(users, u => [u.id, String(u.id)]), // [1,"1",2,"2",3,"3"]
};
```

Constraints remain the same for array callbacks:

- Callback must be an arrow function with exactly one parameter
- Body must be a single expression
- Only the callback parameter and literals are allowed (property access and computed keys with the parameter are fine)
- Nested macros are allowed both in the array argument and inside the callback body
- `arrayFlatMap` flattens only one level, matching JavaScript `Array.prototype.flatMap`

## Runtime expression evaluator

Install `@conf-ts/expression` when an application needs to evaluate expressions emitted by `expr()` or expressions supplied as strings:

```bash
pnpm add @conf-ts/expression
```

The default export accepts either a serialized expression string or an `Expr` callback and returns a reusable function. String expressions are parsed; callback expressions are returned directly so their closures remain available. The function receives a plain environment object whose properties become the serialized expression's root identifiers.

```ts
import expression from '@conf-ts/expression';

const calculate = expression('subtotal * (1 + taxRate)');

calculate({ subtotal: 100, taxRate: 0.08 }); // 108
```

Pass `expression(source, { optionalMemberAccess: true })` (or the equivalent `{ loose: true }` alias) to make non-optional property access behave like optional member access: `a.b.c` acts like `a?.b?.c` and returns `undefined` if the chain crosses `null` or `undefined`. Calls are not made optional: an interrupted callee chain such as `a.b.c()` returns `undefined`, but calling an existing property whose value is `undefined` still throws a non-callable error. Callback-form `Expr` values ignore this option.

Parsed string expressions are cached in a 1,000-entry LRU cache by source and option mode, so parsing the same source repeatedly returns the same function for the same mode (`optionalMemberAccess` and its `loose` alias share the same cache bucket). Callback expressions preserve their original identity. The package public API is intentionally evaluation-only: it exports the default `expression()` function and evaluation-facing TypeScript types. Tooling that needs lexer/parser primitives should import `@conf-ts/expr-core` instead.

#### `LooseExpr`: omitting `?.` for deeply optional context types

`LooseExpr<Context, ReturnType>` is a type-only counterpart to `Expr<Context, ReturnType>`. When a `Context` has nested optional properties (e.g. `{ a?: { b?: { c?: number } } }`), annotating an `expr(...)` result as `LooseExpr` presents the callback with a deeply-required view of `Context`, so the body can be written without `?.` at every level:

```ts
import { expr, type LooseExpr } from '@conf-ts/macro';

type Context = { a?: { b?: { c?: number } } };

// No `?.` needed: LooseExpr contextually types `ctx` as deeply required.
const check: LooseExpr<Context, number | boolean> = expr(
  ctx => ctx.a.b.c || true,
);
```

Only container types (nested objects, arrays) are made non-optional so that navigation type-checks without `?.`; the value ultimately read at the end of a path is still unioned with `undefined` whenever that path crossed an optional level, even if the leaf field itself isn't declared optional. For `{ a?: { b?: { c?: { d: string } } } }`, `ctx.a.b.c.d` type-checks without any `?.`, but its type is `string | undefined` (not `string`), since `a`/`b`/`c` being missing at runtime makes `d`'s read short-circuit to `undefined` too.

`LooseContext` also recurses into array element types, so indexed access through an array of optional-field objects (`ctx.a[0].b.c`) works the same way — both at the type level and at runtime, since `optionalMemberAccess`/`loose: true` already short-circuits `a[b][c]`-style bracket access exactly like `a.b.c` (bracket vs. dot access aren't distinguished). Tuple element positions aren't preserved through `LooseContext`, since indexed access can't recover which tuple slot was read anyway.

`expr()`'s compile-time behavior is unchanged — the macro already treats `ctx.a.b.c` as a plain property chain, which is exactly what `optionalMemberAccess`/`loose: true` needs at runtime. Because of that, `LooseExpr` values must be evaluated with `optionalMemberAccess: true` (or `loose: true`); `expression()` only accepts a `LooseExpr` argument when one of those is set, and otherwise falls back to a `Compiled` function that requires the deeply-required shape (matching the fact that, without the option, a missing property really does throw):

```ts
import expression from '@conf-ts/expression';

const compiled = expression(check, { loose: true });
compiled({}); // fine: `a` is optional in the original Context
```

### Runtime expression syntax

| Category    | Supported syntax                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Literals    | Decimal numbers (including exponent notation), strings, booleans, `null`, `undefined`                       |
| Collections | Array literals; object literals with identifier/string keys, trailing commas, and object spread             |
| Access      | Identifiers, `object.property`, `object[key]`, optional member access (`object?.property`, `object?.[key]`) |
| Calls       | Functions and methods supplied by the environment; method calls preserve `this`                             |
| Templates   | Template literals, nested interpolation, and tagged templates                                               |
| Arithmetic  | `+`, `-`, `*`, `/`, `%`, `**`                                                                               |
| Comparison  | `<`, `<=`, `>`, `>=`, `==`, `!=`, `===`, `!==`, `in`, `instanceof`                                          |
| Bitwise     | `&`, `\|`, `^`, `~`, `<<`, `>>`, `>>>`                                                                      |
| Logical     | `!`, `&&`, `\|\|`, `??` with short-circuit evaluation                                                       |
| Unary       | Unary `+`/`-`, `typeof`, `void`, `delete`                                                                   |
| Control     | Parentheses and conditional expressions (`condition ? yes : no`)                                            |

The parser applies JavaScript-style precedence to the supported operators, including right-associative exponentiation.

### Runtime semantics and safety

Within the supported grammar, serialized expressions follow JavaScript semantics:

- Missing properties evaluate to `undefined`; non-optional access through `null` or `undefined` throws.
- Accessor, Proxy, non-callable, and invoked-function errors propagate.
- Unary coercion, `&&`, `||`, optional chaining, object spread, array holes, `this`, `delete`, and `void` behave like their JavaScript counterparts.
- Errors from runtime callbacks and serialized compiler output are expected to agree by error type and timing; engine-specific message text is not part of the contract.

This package is an evaluator, not a security sandbox. Expressions can read objects and invoke functions exposed through the environment. Do not expose capabilities that untrusted expressions must not access.

The runtime grammar does not support assignments, `++`/`--`, array spread, object shorthand/computed keys, arrow or function expressions, `new`, classes, regular expressions, comments, or statements.

## Programmatic API

### Node (compile files on disk)

```ts
import { compile } from '@conf-ts/compiler';

const { output, dependencies } = compile('path/to/index.conf.ts', 'json');
// output: string (JSON or YAML)
// dependencies: string[] of files that were evaluated
```

### Browser / in-memory (perfect for playgrounds)

```ts
import { compileInMemory } from '@conf-ts/compiler';

const files = {
  '/index.conf.ts': "export default { foo: 'bar' }",
};

const { output, dependencies } = compileInMemory(
  files,
  '/index.conf.ts',
  'json',
);
```

The compiler also accepts source supplied by a loader or editor.
The supplied `code` wins over the matching file in the optional project
snapshot, so compilation never needs a macro-specific API:

```ts
compile(
  {
    filename: '/index.conf.ts',
    code: "export default { foo: 'bar' }",
    project: { files: { '/index.conf.ts': "export default { foo: 'bar' }" } },
  },
  'json',
);
```

### Options

| Option             | Description                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `preserveKeyOrder` | Preserves object key insertion order during object creation, serialization, cloning, and merge |

```ts
import { compile, compileInMemory } from '@conf-ts/compiler';

compile('path/to/index.conf.ts', 'json', { preserveKeyOrder: true });

compileInMemory(
  { '/index.conf.ts': 'export default { a: 1, b: 2, c: 3 }' },
  '/index.conf.ts',
  'json',
  undefined,
  { preserveKeyOrder: true },
);
```

### Macro transform

Macros are a source transform, not a compiler mode. Transform the current
module first, then pass the resulting ordinary TypeScript to either compiler:

```ts
import { readFileSync } from 'node:fs';
import { compile } from '@conf-ts/compiler';
import {
  createMacroProjectSnapshot,
  transform,
} from '@conf-ts/macro-transformer';

const filename = 'path/to/index.conf.ts';
const code = readFileSync(filename, 'utf8');
const project = createMacroProjectSnapshot([filename]);
const transformed = transform(
  { filename, code, project },
  { quote: 'single', env: process.env },
);

const result = compile({ filename, code: transformed.code, project }, 'json');
```

For a multi-file project, transform every module that contains macros and put
each transformed source back into `project.files` before calling `compile`.
The compiler only receives ordinary TypeScript and never expands macros.

## Webpack plugin

`ConfTsWebpackPlugin` compiles each matching `.conf.ts` file and writes the generated JSON/YAML next to the source file by default. Add the plugin once — no separate `module.rules` entry is needed.

```js
// webpack.config.js
const {
  ConfTsWebpackPlugin,
  TypeScriptMacroTransformPlugin,
} = require('@conf-ts/webpack-plugin');

module.exports = {
  plugins: [
    new TypeScriptMacroTransformPlugin({
      // A pre-loader that expands macros in JS/TS modules.
      quote: 'double',
    }),
    new ConfTsWebpackPlugin({
      // All options are optional.
      test: /\.conf\.ts$/, // default
      extensionToRemove: '.conf.ts', // default; can also be an array of strings
      format: 'json', // 'json' | 'yaml'
      name: '[path][name].generated.json', // default; see template tokens below
      preserveKeyOrder: false,
      check: false, // verify-only mode for CI; reads sidecar file next to source
      useWorkers: true, // off-thread compile via piscina; set false for small builds
      compiler: 'auto', // 'auto' | 'native' | 'js' — 'auto' prefers @conf-ts/compiler-native if available
    }),
  ],
};
```

`extensionToRemove` accepts either a string or an array of strings. When you broaden `test`, pass every suffix that should be stripped:

```js
new ConfTsWebpackPlugin({
  test: /\.conf\.(ts|mts|cts)$/,
  extensionToRemove: ['.conf.ts', '.conf.mts', '.conf.cts'],
});
```

`name` supports the following tokens: `[name]` (source basename without the longest matching `extensionToRemove` value), `[ext]` (source extension), and `[path]` (directory relative to webpack/rspack `context`). The default is `[path][name].generated.${format}` so generated files are written beside their source files, not under `output.path`. `check` mode resolves the same path and verifies the generated file without writing it.

With `compiler: 'auto'` (the default), the plugin loads `@conf-ts/compiler-native` if it's installed and falls back to `@conf-ts/compiler` otherwise. Force one or the other with `compiler: 'native'` (errors if the native binding can't be loaded) or `compiler: 'js'`.

Use `NativeMacroTransformPlugin` instead when the native Oxc-backed transformer is
installed. It intentionally does not fall back to the TypeScript transformer.
The same plugins are available from
`@conf-ts/webpack-plugin/macro-transform-plugin/typescript` and
`@conf-ts/webpack-plugin/macro-transform-plugin/native`.

## Supported config TypeScript

- Literals: string, number, boolean, null
- `undefined` with JS serialization semantics
- String template literals
- Object/array literals, spreads, shorthand properties
- Array holes serialize like JavaScript arrays (`null` in JSON/YAML output)
- Object and array destructuring in `const` bindings (including nested patterns, computed keys, default values, and rest)
- Enums (string and numeric), including whole enum object expansion
- Property access (including enums)
- Element access: `arr[i]`, `obj["key"]`, `obj[CONST]`
- Default imports, namespace imports, and re-exports for constants
- Optional chaining: `a?.b`, `a?.[i]`, `a?.()`
- Arithmetic and comparison operators (+ - \* / % \*\*, equality, and ordering)
- Bitwise operators (`& | ^ << >> >>>`)
- Logical (`&& || ??`), `in`, and `instanceof Array/Object` operators
- Unary prefix (+ - ! ~), `typeof`, `void`, and `delete`
- Non-null assertions (`!` postfix)
- Conditional (ternary)
- Sequence/comma expressions
- Parenthesized and `as`/`satisfies` expressions

## Not supported in config values

- Functions (arrow/function expressions) in values
- `new Date()` and other `new` expressions
- Regular expressions
- `let`/`var` for referenced variables (only `const` is allowed)

## Scripts

```bash
pnpm build
pnpm test
pnpm format
```

## License

MIT
