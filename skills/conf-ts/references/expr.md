# Expression macros and the runtime evaluator

Use `expr()` when a value can only be resolved later, against data available at
runtime — a permission check, a feature-flag rule, a pricing formula. Write it as
ordinary type-checked TypeScript; during compilation the macro turns it into a
portable **expression string** instead of running it.

Requires macro mode and importing the expression macro being used from
`@conf-ts/macro`.

## Basics

```ts
import { expr } from '@conf-ts/macro';

enum Status { Active = 'active' }
const MIN_AGE = 18;

type UserContext = { user: { age: number; status: Status } };

export default {
  canEnter: expr((ctx: UserContext) =>
    ctx.user.age >= MIN_AGE && ctx.user.status === Status.Active,
  ),
};
```

```json
{ "canEnter": "user.age >= 18 && user.status === \"active\"" }
```

The context parameter's name is stripped; constants and enum members are folded
to literals. Note there's no `boolean` written anywhere — `ReturnType` is
inferred from the callback body once `ctx` carries a type.

### Typing the callback: prefer inference over explicit type arguments

`Context` can never be inferred from how the callback *uses* `ctx` — a bare
`ctx => ctx.user.age` types `ctx` as `unknown` and fails to compile, since
`ctx`'s type is a parameter (contravariant) position TypeScript can't recover
from usage inside the body. Pin `Context` with an inline parameter annotation
and let everything else — `ReturnType`, and for `exprTemplate` every later
parameter and the `Parameters` tuple — infer normally:

```ts
const canEnter = expr((ctx: UserContext) => ctx.user.age >= MIN_AGE);
// Expr<UserContext, boolean> — ReturnType inferred, nothing else to write

const withTax = exprTemplate(
  (ctx: Context, taxRate: number) => ctx.subtotal * (1 + taxRate),
);
// ExprTemplate<Context, number, [number]> — all inferred from the callback
```

Reach for the full explicit type argument list — `expr<Context, Result>(...)`
/ `exprTemplate<Context, Result, Parameters>(...)` — only when inference can't
produce the type you actually want:

- **The callback returns an object or array literal.** An inline `ctx`
  annotation only pins `Context`; the return value's shape is still whatever
  TypeScript structurally infers from the literal, so a typo'd or missing key
  type-checks fine and is only caught later, if ever, wherever the value
  happens to be consumed against an expected type:

  ```ts
  type Pricing = { base: number; tax: number };

  // Typo ("tex") — compiles fine with only `ctx` annotated:
  const wrong = expr((ctx: Context) => ({ base: ctx.subtotal, tex: 0 }));

  // Same typo, caught immediately at the definition:
  const right = expr<Context, Pricing>(ctx => ({ base: ctx.subtotal, tex: 0 }));
  //                                                                   ~~~ error here
  ```

- **`LooseExpr`.** Use the dedicated `looseExpr()` macro so the call directly
  infers a `LooseExpr` result. Supply the complete type argument pair because
  the loosened callback context isn't something you can spell as a parameter
  annotation:

  ```ts
  const check = looseExpr<Context, number | boolean>(
    ctx => ctx.a.b.c || true,
  );
  ```

- **`LooseExprTemplate`.** Use `looseExprTemplate()` with the complete three
  type arguments for the same direct inference when defining a reusable loose
  template.

  The same "annotate the binding, not the call" trick works for plain
  `Expr`/`ExprTemplate` too, whenever you already have a named type to reuse
  across sibling declarations instead of repeating a call-site type argument
  list on each one.

**Never write a partial type argument list.** `expr<Context>(ctx => ...)` or
`looseExpr<Context>(ctx => ...)` compiles without error, but it does *not* infer `ReturnType` from the
callback — it silently defaults to `unknown`, discarding return-type safety
with no diagnostic to warn you. The same applies to `exprTemplate<Context>(...)`
or `exprTemplate<Context, ReturnType>(...)`: every type parameter after the
ones you supplied defaults instead of inferring, which then makes an
otherwise-correct annotated later parameter (`(ctx, rate: number) => ...`)
fail to type-check against the defaulted `unknown`. Supply either zero
explicit type arguments (relying on inline annotations or a binding
annotation) or the complete list — nothing in between.

### Callback rules

- Synchronous **arrow function** with an **expression body**.
- Exactly one identifier parameter, or **no parameter at all**.
- Root context access must go through a property: `ctx.user`, `ctx['user']`.
  Bare `ctx` is rejected. A computed root key (`ctx[key]`) must resolve to a
  valid identifier name at compile time.
- Rejected: block bodies, `function` expressions, `async`, assignments,
  `++`/`--`, `new`, regex — anything outside the runtime grammar below.

All rejections surface as `Unsupported call expression: expr` (TypeScript
transformer) / `Function "expr" is only allowed in macro mode` (native).

### Operators

Everything in the runtime grammar is available:

```ts
expr((ctx: Context) => ctx.base ** ctx.exponent);   // "base ** exponent"
expr((ctx: Context) => ctx.left >>> ctx.right);      // "left >>> right"
expr((ctx: Context) => ctx.key in ctx.object);        // "key in object"
expr((ctx: Context) => ctx.v instanceof ctx.Ctor);    // "v instanceof Ctor"
expr((ctx: Context) => delete ctx.object.removable);
expr((ctx: Context) => typeof ctx.value);
```

### Formatting of the emitted string

- Formatting whitespace (newlines, tabs, runs of spaces) collapses to a single
  space; whitespace **inside** string and template literals is preserved.
- Comments are erased; type assertions (`as`, `satisfies`, `<T>`, `!`) and
  explicit type arguments are erased.
- Semantically redundant parentheses are removed, precedence-required ones kept:

  | Source                       | Emitted            |
  | ---------------------------- | ------------------ |
  | `(((ctx.a)))`               | `a`                |
  | `ctx.a + (ctx.b * ctx.c)`   | `a + b * c`        |
  | `(ctx.a + ctx.b) * ctx.c`   | `(a + b) * c`      |
  | `ctx.a - (ctx.b - ctx.c)`   | `a - (b - c)`      |
  | `(ctx.a ?? ctx.b) \|\| ctx.c` | `(a ?? b) \|\| c` |
  | `(ctx.a ** ctx.b) ** ctx.c` | `(a ** b) ** c`    |
  | `(-ctx.a) ** ctx.b`         | `(-a) ** b`        |

### Quote style

String literals in the emitted expression use double quotes by default; a build
may switch this to single quotes. Either way it is the *output* encoding, not
something you control per call — write the callback with whichever quotes the
file's style uses, and expect the emitted string to be normalized.

## Other macros inside `expr()`

`String`/`Number`/`Boolean`/`env` fold to literals whenever their argument is
compile-time known, and stay as runtime calls when it depends on the context:

```ts
expr((ctx: Context) => ctx.a === String(1));                // "a === \"1\""
expr((ctx: Context) => ctx.mode === env('MODE', 'dev'));     // "mode === \"dev\""
expr((ctx: Context) => ctx.a === String(ctx.n));             // "a === String(n)"
expr((ctx: Context) => Number(ctx.n + 41));                  // "Number(n + 41)"
```

A property or object key that merely happens to be spelled like the context
parameter is not a reference to it, and still folds.

Rejected: a macro call referencing an identifier that is neither a constant nor
sourced from the context, and a cast macro called with the wrong arity.

## Composing `Expr` values

A compiled `Expr` can be called with the current context; the transformer inlines
it recursively and adds parentheses to preserve precedence.

```ts
type Context = { a: boolean; b: boolean; c: boolean };

const bOrC = expr((ctx: Context) => ctx.b || ctx.c);
const alias = bOrC;
const scored = expr((ctx: Context) => ctx.a && alias(ctx));

export default {
  single: expr((ctx: Context) => ctx.a && bOrC(ctx)),      // "a && (b || c)"
  multiLevel: expr((ctx: Context) => scored(ctx) || ctx.c),
};
```

- Resolves through local `const` aliases, directly named/default imported
  `Expr` values, and Expr values carried by statically analyzed `modifier()` or
  `exprTemplate()` arguments (including parameter properties such as
  `input.condition`), at any nesting depth, across files.
- The argument must be the enclosing callback's **bare parameter identifier**
  (any name, not just `ctx`).
- Rejected — `subExpr(ctx.child)`, `subExpr(other)`, `subExpr()`,
  `subExpr(ctx, ctx)`, `subExpr(...[ctx])`:
  `Nested Expr 'subExpr' must be called with exactly one argument: the current expr context parameter 'ctx'.`
- Namespace properties outside a static template argument, function-returned
  `Expr` values, and re-export chains are **not** resolved as composed `Expr`
  sources.
- Ordinary (non-`Expr`) functions are not subject to this validation.

### Context-less expressions

```ts
const always = expr(() => true);

export default {
  literal: expr(() => true),                 // "true"
  computed: expr(() => 1 + 2),               // "1 + 2"
  combined: expr(() => always() && 1 < 2),   // "true && 1 < 2"
};
```

A nested `Expr` composed into a context-less callback must be called with **no**
arguments.

## Nested callbacks inside `expr()`

The body may call methods that take their own callback. Callbacks are
down-leveled to expression-bodied arrow text.

```ts
type Context = { matrix: number[][]; threshold: number; scores: number[] };

export default {
  countPositiveRows: expr(
    (ctx: Context) => ctx.matrix.filter(row => row.some(cell => cell > ctx.threshold)).length,
  ),
  reduceSum: expr(
    (ctx: Context) => ctx.scores.reduce((sum, value) => sum + value, 0),
  ),
};
```

Emitted: `matrix.filter(row => row.some(cell => cell > threshold)).length`,
`scores.reduce((sum, value) => sum + value, 0)`.

Supported callback forms:

- Arrow function or `function` expression.
- Expression body, or a block body containing a **single** `return` statement.
  Both down-level to the same arrow text.
- Zero, one, or many parameters.
- Parameters may be plain identifiers, **one level** of object/array
  destructuring (defaults, renaming, holes, pattern rest), and a single trailing
  rest parameter.
- Arbitrary nesting depth; inner callbacks may reference the outer `expr()`
  context and bindings from any enclosing callback.
- Method calls on non-context receivers stay as runtime calls:
  `[1, 2].includes(ctx.quota)` → `[1, 2].includes(quota)`.

```ts
ctx => ctx.pairs.some(({ a, b = MIN_SCORE }) => a < b)  // "pairs.some(({a, b = 3}) => a < b)"
ctx => ctx.matrix.map(([, b]) => b)                      // "matrix.map(([, b]) => b)"
ctx => ctx.queue.reduce((sum, ...rest) => sum + rest.length, 0)
```

Not supported inside a nested callback: `async`/generator functions, type
annotations, more than one statement in a block body, and a parameter name that
**shadows** the `expr()` context parameter or a name bound by an enclosing
callback.

### Object/array syntax in expressions

```ts
expr((ctx: Context) => [...ctx.items, 99]);                       // "[...items, 99]"
expr((ctx: Context) => ({ TAX_RATE, key: ctx.key }));             // "{TAX_RATE: 0.08, key: key}"
expr((ctx: Context) => ({ [ctx.key]: ctx.value }));                // "{[key]: value}"
expr((ctx: Context) => ctx.items.map(item => ({ item, doubled: item * 2 })));
```

Shorthand referencing an outer constant folds to a literal; shorthand
referencing a callback's own parameter stays as runtime shorthand.

## `exprTemplate()` / `looseExprTemplate()`: reusable parameterized expressions

The callback's first parameter is always the runtime context; every parameter
after it is supplied at instantiation and folded into the emitted expression. The
same typing preference from "Typing the callback" above applies here:
annotate `ctx` and every later parameter inline and
`ReturnType`/`Parameters` both infer — don't write
`exprTemplate<Context, ReturnType, Parameters>(...)` unless the return value
needs its shape checked against a declared type. Because there are three type
parameters instead of two, a partial list is an even easier mistake to make
here — `exprTemplate<Context>(...)` and `exprTemplate<Context, number>(...)`
both silently default the parameters after the ones given, which then breaks
type-checking for correctly-annotated later parameters. For a loose context,
use the complete `looseExprTemplate<Context, ReturnType, Parameters>(...)`
argument list so the macro directly supplies the loosened callback type.

```ts
import { exprTemplate, looseExprTemplate } from '@conf-ts/macro';

type Context = { subtotal: number; customer?: { discount?: number } };

const withTax = exprTemplate(
  (ctx: Context, taxRate: number) => ctx.subtotal * (1 + taxRate),
);

const singaporeTotal = withTax(0.09);   // "subtotal * (1 + 0.09)"

const discounted = looseExprTemplate<Context, boolean, [number]>(
  (ctx, minimum) => (ctx.customer.discount ?? 0) >= minimum,
);
```

Rules:

- The context parameter must be a **plain identifier** — destructuring it fails
  with `exprTemplate callback must be a synchronous arrow function whose first parameter is a plain context identifier`.
- Later parameters support optional/default values, a trailing rest parameter,
  and one level of object/array destructuring (defaults, holes, renaming,
  pattern rest). Nested patterns and computed binding keys are not supported.
  Defaults evaluate in declaration order and may reference earlier template
  parameters or outer constants.
- Arguments must be statically analyzable: literals, enums, imported/local
  `const` values, `undefined`, `null`, finite numbers, strings, booleans,
  arrays, plain objects, and static array spreads.
- `exprTemplate()` specializes to `Expr`; `looseExprTemplate()` specializes to
  `LooseExpr`. Both can take part in `subExpr(ctx)` composition.
- With the macro transform option `pruneExprTemplate: true`, ternary conditions
  that depend only on template arguments and other static values are replaced
  by their selected branch during specialization. `typeof`, unary,
  comparison/equality, logical, and nullish operations supported by the static
  evaluator may participate in the condition. Only the selected branch is
  visited, so an invalid value in an unreachable branch does not fail
  specialization.
- `pruneExprTemplate` defaults to `false`, preserving the full conditional and
  skipping the extra analysis. Conditions involving `ctx`, unsupported
  operations, and ordinary `expr()` callbacks remain unchanged even when it is
  enabled. Pass the option to `transform`/`transformProject` or either
  `TypeScriptMacroTransformPlugin` / `NativeMacroTransformPlugin`.
- Templates forward through `const` aliases, named/default/namespace imports, and
  named/default/star re-export chains.
- The template itself is compile-time-only: it cannot escape into runtime data
  (`{ invalid: [add] }`) or be invoked dynamically (`function f(v) { return add(v); }`).

```ts
const includes = exprTemplate(
  (ctx: Context, allowed: number[]) => allowed.includes(ctx.a),
);
includes([1, 2, 3]);   // "[1, 2, 3].includes(a)"
```

Errors: `exprTemplate arguments must be statically analyzable`,
`exprTemplate expected at least N static argument(s), but received M`,
`exprTemplate expected at most N static argument(s), but received M`,
`exprTemplate values are compile-time-only`. These use the normal detailed
diagnostic format with the source location, source line, reference chain, and
specific suggested fixes. Branch pruning itself is conservative: an
undecidable condition is retained instead of producing a pruning error.

## `LooseExpr`: skipping `?.` for deeply optional contexts

`looseExpr()` returns `LooseExpr<Context, ReturnType>` and presents the callback
with a deeply-required view of `Context` so the body reads naturally. The macro
function determines the result type without a binding annotation:

```ts
import { looseExpr } from '@conf-ts/macro';

type Context = { a?: { b?: { c?: number } } };

const check = looseExpr<Context, number | boolean>(ctx => ctx.a.b.c || true);
```

Only container types (nested objects, arrays, including object types inside
array element types) are made non-optional. The value read at the end of a path
that crossed an optional level is still unioned with `undefined`: for
`{ a?: { b?: { c?: { d: string } } } }`, `ctx.a.b.c.d` type-checks with no `?.`
but has type `string | undefined`. Tuple element positions are not preserved.

Compile-time output is identical to `expr()`. **`LooseExpr` values must be
evaluated with `optionalMemberAccess: true` (or `loose: true`)** — `expression()`
only accepts a `LooseExpr` argument when one of those options is set.

## The grammar the emitted string may use

The compiled string is evaluated later by `@conf-ts/expression`, against a plain
environment object whose properties become the expression's root identifiers.
That grammar is the real limit on what you can write inside `expr()` — anything
outside it is rejected at compile time.

```ts
// config.conf.ts
export default { canEnter: expr((ctx: UserContext) => ctx.user.age >= 18) };
// → { "canEnter": "user.age >= 18" }
// consumed at runtime as: expression(config.canEnter)({ user: { age: 20 } })
```

### Supported syntax

| Category    | Supported                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Literals    | Decimal numbers incl. exponents, strings (with `\uXXXX` escapes), booleans, `null`, `undefined`                              |
| Collections | Array literals with spread; object literals with identifier/string/computed keys, shorthand, trailing commas, object spread   |
| Access      | Identifiers, `o.p`, `o[k]`, `o?.p`, `o?.[k]`                                                                                  |
| Calls       | Functions and methods from the environment; method calls preserve `this`                                                      |
| Functions   | Arrow functions as callback arguments — expression bodies only, with identifier/destructured/rest/defaulted params, nesting, closures |
| Templates   | Template literals, nested interpolation, tagged templates                                                                     |
| Arithmetic  | `+ - * / % **` (right-associative `**`)                                                                                       |
| Comparison  | `< <= > >= == != === !==`, `in`, `instanceof`                                                                                 |
| Bitwise     | `& \| ^ ~ << >> >>>`                                                                                                          |
| Logical     | `! && \|\| ??` with short-circuiting                                                                                          |
| Unary       | `+ -`, `typeof`, `void`, `delete`                                                                                             |
| Control     | Parentheses, conditional `c ? a : b`                                                                                          |

Not supported: assignments, `++`/`--`, block-bodied arrows, `new`, classes,
regular expressions, comments.

### Runtime semantics to write against

Within that grammar the evaluator follows JavaScript: missing properties are
`undefined`; non-optional access through `null`/`undefined` **throws**; accessor,
Proxy, non-callable and invoked-function errors propagate; unary coercion,
short-circuiting, spread, computed keys, array holes, `this`, `delete`, and
`void` behave as in JS.

Two consequences for how you write the callback:

- **Guard optional paths.** `ctx.a.b.c` compiles happily and then throws at
  runtime if `a` is missing. Either write `ctx.a?.b?.c`, or annotate the result
  as `LooseExpr` and have the consumer evaluate with `loose: true`.
- **Only call what the environment will actually provide.** Method calls on
  non-context receivers (`[1, 2].includes(...)`, `'ab'.includes(...)`) survive as
  runtime calls, and array methods resolve against the real value passed in. A
  helper the runtime doesn't supply becomes an error only when the expression is
  evaluated, not when the config compiles.

The evaluator is not a security sandbox — an expression can read any object and
invoke any function reachable through the environment. Keep configs that carry
`expr()` output under the same review as code.
