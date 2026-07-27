# Config syntax reference (plain mode)

Everything here works without macro mode. The compiler evaluates the module at
build time and serializes the default export.

## Entry point

The entry file must produce a default export. All three forms work:

```ts
export default { name: 'test', version: 1 };
```

```ts
const cfg = { named: true, value: 42 };
export { cfg as default };
```

```ts
export { default } from './source';
```

Anything else fails with `No default export found in the entry file`.

## Values and literals

```ts
export default {
  a: 1,
  b: 'hello',
  c: true,
  d: null,
  e: { f: 1.23, g: 'world' },
  h: [1, 2, 3],
};
```

Template literals interpolate constants and enums:

```ts
const name = 'John Doe';
enum Greeting { Welcome = 'Welcome' }

export default {
  greeting: `Hello, ${name}!`,
  greetingAlt: `${Greeting.Welcome}, ${name}!`,
};
```

## Constants

Only `const`. A referenced `let`/`var` throws
`Failed to evaluate variable "c". Only 'const' declarations are supported, but it was declared with 'let'.`
Constants may reference each other:

```ts
export const CONST_A = 100;
export const CONST_B = CONST_A + 50; // 150
```

## Enums

Numeric (with auto-increment and computed initializers), string, and whole-enum
expansion are all supported.

```ts
enum MyEnum { A, B = 5, C }          // 0, 5, 6
enum MyStringEnum { Foo = 'foo' }
enum MyInitialized { A = 10, B = A + 5, C = B * 2 }  // 10, 15, 30
```

Spreading a whole enum object emits TypeScript's **runtime** shape, so numeric
enums include the reverse mapping:

```ts
enum Numeric { A = 1, B = 2 }
enum Stringy { Foo = 'foo', Bar = 'bar' }
export default { Numeric, Stringy };
```

```json
{
  "Numeric": { "1": "A", "2": "B", "A": 1, "B": 2 },
  "Stringy": { "Foo": "foo", "Bar": "bar" }
}
```

## Objects, arrays, spread

```ts
const base = { a: 1, b: 2 };
const extended = { ...base, c: 3, d: { e: 5, ...{ f: 6 } } };
const arr2 = [...[1, 2], 3, 4, ...[7, 8]];
```

Object and array spread, shorthand properties, quoted keys, and computed keys
(including template-literal keys) all work:

```ts
const key = 'super';
export default {
  'test-1': { cool: 123 },
  [key]: { cool: 789 },
  [`test-${key}`]: { cool: 101112 },
};
```

### Key ordering

By default an overridden key **moves to the end**:

```ts
const obj = { a: 1, b: 2, c: 3 };
export default { partial: { ...obj, b: 'new' } };
// { "partial": { "a": 1, "c": 3, "b": "new" } }
```

When the build enables `preserveKeyOrder`, insertion order is preserved
instead:

```json
{ "partial": { "a": 1, "b": "new", "c": 3 } }
```

The setting applies to object creation, serialization, cloning, and merge. It is
a build-wide choice, so write configs that read correctly under either ordering
rather than depending on one.

## Destructuring in `const` bindings

Nested patterns, computed keys, defaults, rest, array holes:

```ts
const KEY = 'dynamic';
const source = { nested: { value: 10 }, dynamic: 20, keep: 'yes', remove: 'no' };
const { nested: { value }, missing = 30, [KEY]: computed, remove, ...rest } = source;

const arr = [1, [2, 3], undefined];
const [first, [second, third], fallback = 4, ...tail] = arr;
```

## Access

```ts
const arr = [10, 20, 30];
const obj = { name: 'alice' };
const KEY = 'name';
const matrix = [[1, 2], [3, 4]];

export default {
  first: arr[0],
  indexed: arr[idx],
  computed: arr[1 + 1],
  byKey: obj['name'],
  byComputedKey: obj[KEY],
  nested: matrix[1][0],
  outOfRangeFallback: arr[5] ?? 'none',
};
```

Optional chaining (`a?.b`, `a?.[i]`, `a?.()`) and non-null assertions (`x!`,
including chains like `nested!.a!.b!.c!`) are supported. A non-null assertion on
a value that really is nullish is an error — see `errors.md`.

## Operators

| Category   | Supported                                                        |
| ---------- | ---------------------------------------------------------------- |
| Arithmetic | `+ - * / % **`                                                   |
| Bitwise    | `& \| ^ << >> >>>` and `~`                                       |
| Comparison | `< <= > >= == != === !==`                                        |
| Logical    | `&& \|\| ??` with JS truthiness and short-circuiting             |
| Unary      | `+ - ! ~`, `typeof`, `void`, `delete`                            |
| Relational | `in`, `instanceof Array`, `instanceof Object`                    |
| Other      | ternary, sequence/comma `(a, 3)`, parentheses                    |
| Types      | `as`, `as const`, `satisfies`, non-null `!`                      |

`typeof` on an undeclared identifier yields `"undefined"` rather than throwing.

## JavaScript serialization semantics

```ts
const obj = { a: 1, b: undefined };
const arr = [, 1, undefined];
const methodObj = { a: 1, b() { return 2; } };

export default {
  fallback: obj.missing ?? 2,   // 2
  directMissing: obj.missing,   // key omitted (undefined)
  array: arr,                   // [null, 1, null]
  sequence: (obj.a, 3),         // 3
  methodObj,                    // { "a": 1 } — the method is dropped
};
```

Array holes and `undefined` elements serialize as `null`, matching
`JSON.stringify`.

## Not supported in config values

- Functions (arrow or `function` expressions) → `Unsupported type: Function`
- `new Date()` and any other `new` expression → `Unsupported type: Date`
- Regular expressions → `Unsupported type: RegExp`
- `let` / `var` for referenced variables

## Multi-file configs

Relative imports, default imports, namespace imports, and re-export chains all
resolve:

```ts
import defaultConfig, * as namespaceConfig from './reexport-source';
import { ALPHA, BETA, GAMMA } from './reexport-mid';
```

```ts
// reexport-mid.ts
export { ALPHA } from './reexport-source';
export * from './reexport-extra';
export * as groupedValues from './reexport-extra';
```

`export { default } from './source'` is resolved too, and the re-exporting file
is reported as a dependency.

### tsconfig path aliases

`paths` from the nearest `tsconfig.json` are honored:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "paths": { "@/*": ["./*"], "@utils/*": ["./utils/*"] }
  }
}
```

```ts
import { MY_CONSTANT } from '@/constants';
import { HELPER_CONSTANT } from '@utils/helper';
```

### What counts as a dependency

Only the `tsconfig.json` plus the files actually evaluated. A module that was
never reached — an unrelated enum declaration, say — is not a dependency and
won't trigger a rebuild. Splitting shared constants into focused modules
therefore keeps watch-mode invalidation tight; a single barrel file that
re-exports everything drags the whole graph into every config.
