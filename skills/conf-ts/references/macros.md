# Macro transform reference

Macros are a **source transform that runs before compilation**. The compiler
itself never expands macros — it only ever sees ordinary TypeScript. A config
that uses macros therefore only compiles when the build has macro mode enabled.

Every macro must be imported from `@conf-ts/macro`.

## Import handling

All of these bind correctly:

```ts
import { String as macroString, String } from '@conf-ts/macro';
import * as macros from '@conf-ts/macro'; // macros.String(42)
```

The transform is binding-aware:

- A **locally declared** `String` is left completely untouched.
- An **unimported** `String(1)` / `modifier(...)` / `expr(...)` is left untouched, and then the
  compiler rejects it as an unevaluatable call.
- A parameter that shadows a macro name inside a function body is untouched.
- Only macro specifiers are stripped from a mixed import; `import { String, type PreservedType }`
  becomes `import { type PreservedType }`.
- A namespace import that is also used as a type (`typeof macros`) is retained.
- Calls that **cannot** be transformed (e.g. `arrayMap` with a `function`
  expression callback) are left in place along with their import, and fail later
  in the compiler.

A successfully transformed file has no `from '@conf-ts/macro'` import left.

**Runtime safety net:** importing `@conf-ts/macro` logs a warning, and calling
any macro at runtime throws
`'<name>' is a compile-time macro from '@conf-ts/macro' and must be expanded by the conf-ts macro transformer; it cannot run at runtime.`
If you see that error, the transform did not run.

## Type casting: `String()`, `Number()`, `Boolean()`

```ts
import { Boolean, Number, String } from '@conf-ts/macro';

const MY_CONSTANT = 456;
enum MyEnum {
  A = 1,
  B,
  C = '1005',
}

export default {
  toString: String(123), // "123"
  toNumber: Number('123'), // 123
  toBoolean: Boolean('true'), // true
  constantToString: String(MY_CONSTANT), // "456"
  enumToString: String(MyEnum.A), // "1"
  enumToNumber: Number(MyEnum.C), // 1005
};
```

Follows JavaScript coercion. Works on literals, constants, and enum members.

## Arrays: `arrayMap`, `arrayFilter`, `arrayFlatMap`

```ts
import { arrayFilter, arrayFlatMap, arrayMap } from '@conf-ts/macro';

const nums = [1, 2, 3, 4];

export default {
  doubled: arrayMap(nums, x => x * 2), // [2, 4, 6, 8]
  evens: arrayFilter(nums, x => x % 2 === 0), // [2, 4]
  expanded: arrayFlatMap(nums, x => [x, x * 10]), // [1,10,2,20,3,30,4,40]
};
```

Constraints:

- The callback **must be an arrow function with exactly one parameter**. A
  `function` expression fails: `Unsupported call expression: arrayMap`
  (native transformer: `Function "arrayMap" is only allowed in macro mode`).
- The body must be a single expression (expression body, or a return
  expression).
- The parameter may be used in property-access chains (`item.name`), object
  values, spreads, and computed keys (`{ [item.id]: item.value }`).
- `arrayFilter` coerces the returned expression to boolean.
- `arrayFlatMap` flattens exactly one level, like `Array.prototype.flatMap`. A
  non-array input yields `[]`.

Richer callbacks work as long as they stay a single expression:

```ts
const objects = [
  { id: 1, name: 'Alice' },
  { id: 3, name: 'Charlie' },
];

export default {
  mapDouble: arrayMap(nums, x => (x > 1 ? x * 2 : x)),
  mapToString: arrayMap(nums, x => (x > 1 ? `${x}` : 'one')),
  alternateObjects: arrayMap(objects, obj => ({
    ...obj,
    ...(obj.name === 'Charlie' ? { isAdmin: true } : {}),
  })),
};
```

## Environment: `env(key)` / `env(key, defaultValue)`

```ts
import { env, Number } from '@conf-ts/macro';

export default {
  nodeEnv: env('NODE_ENV'), // string | undefined
  exists: env('CONF_TS_EXISTS', 'default'),
  missing: env('CONF_TS_MISSING', 'default'), // "default"
  nested: env('A', env('CONF_TS_EXISTS', 'fallback')),
  port: Number(env('PORT') ?? '3000'),
};
```

The value is read at build time and baked into the output, so `env()` captures
the _build_ environment, never the deploy environment. The build decides whether
the ambient `process.env` is visible or a frozen environment is supplied — treat
any `env()` key as something the build must guarantee, and always give a default
for keys that may be absent.

## Reusable values: `modifier(callback)`

`modifier()` creates a reusable compile-time transformation. The public generic
order is `modifier<ParametersTuple, Output>()`:

```ts
import { modifier } from '@conf-ts/macro';

type InputA = { a: number };
type InputB = { b: number };
type Output = InputA & InputB & { extraProperty: number };

const addProperty = modifier<[InputA, InputB], Output>((inputA, inputB) => ({
  ...inputA,
  ...inputB,
  extraProperty: 3,
}));

export default {
  modifierTest: addProperty({ a: 1 }, { b: 2 }),
};
```

The result is ordinary configuration data:

```json
{ "modifierTest": { "a": 1, "b": 2, "extraProperty": 3 } }
```

Rules:

- The callback must be a synchronous arrow function with an expression body.
- Every argument must be statically analyzable. Literals, enums, local/imported
  `const` values, arrays, plain objects, static array spreads, macros, and other
  modifiers are supported.
- Parameters may be optional/defaulted, use one level of object/array
  destructuring, or end in one trailing rest parameter. Zero parameters work.
- Defaults are evaluated in declaration order and may reference earlier
  parameters or outer constants.
- A modifier can be forwarded through `const` aliases and
  named/default/namespace imports or re-exports. It must be invoked before it
  reaches output data; `[addProperty]` is rejected as an escaping compile-time
  value.
- The return value may be any value accepted by the ordinary conf-ts constant
  evaluator, not only an object.

## Nesting

Macros compose freely, including inside array callbacks. The callback parameter
stays correctly scoped through nested evaluation:

```ts
import { arrayFilter, arrayMap, Boolean, Number, String } from '@conf-ts/macro';

const nums = [0, 1, 2];
const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

export default {
  idStrings: arrayMap(items, item => String(item.id)), // ["1","2","3"]
  multiLevelCast: arrayMap(nums, x => Boolean(Number(String(x)))), // [false,true,true]
  nestedInArg: arrayMap(
    arrayFilter(nums, y => Boolean(y)),
    z => String(z),
  ), // ["1","2"]
  deepChain: String(Number(String(Number(5)))), // "5"
};
```

Enums, `arrayMap`, and casts combine the way you would expect:

```ts
enum Field {
  A = 1,
  B = 2,
}
const fields = [Field.A, Field.B];

export default {
  config: arrayMap(fields, fieldKey => ({
    stringifiedNumber: String(fieldKey),
  })),
};
// [{ "stringifiedNumber": "1" }, { "stringifiedNumber": "2" }]
```

## Macros outside the default export

The transform rewrites every macro call in the module, not just those reachable
from the default export:

```ts
import { String } from '@conf-ts/macro';

export const eagerlyTransformed = String(42); // → "42"
export default { untouched: true };
```

## `expr()` and `exprTemplate()`

These are macros too, but large enough to have their own file — see
`expr.md`.
