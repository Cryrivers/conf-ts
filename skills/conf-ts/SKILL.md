---
name: conf-ts
description: Write conf-ts config files - TypeScript that compiles to plain JSON/YAML. Use when authoring or reviewing .conf.ts files, deciding which TypeScript is allowed inside a config, using @conf-ts/macro (String/Number/Boolean, arrayMap/arrayFilter/arrayFlatMap, env, expr, exprTemplate), configuring opt-in exprTemplate branch pruning, or interpreting a conf-ts compile error.
---

# Writing conf-ts configs

conf-ts compiles a subset of TypeScript into plain JSON or YAML. The config is
authored with types, enums, constants, spreads and imports; the compiler
evaluates it at build time and emits data. **No TypeScript reaches production.**

That single fact drives every rule below: if a value cannot be computed without
running JavaScript at runtime, conf-ts rejects it.

This skill covers what to put *inside* a config file. It does not cover how the
build invokes conf-ts.

## Decide which mode the config needs

| The config needs…                                                     | Write                                            |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| Literals, constants, enums, spreads, arithmetic, imports across files | Plain TypeScript — no macro imports              |
| Casts, array transforms, build-time env injection                     | `@conf-ts/macro` imports (requires macro mode)   |
| A rule or formula that can only be resolved against runtime data      | `expr()` / `exprTemplate()` from `@conf-ts/macro` |

Macro mode is a **source transform that runs before compilation**, not a
compiler mode. If macro mode is off, macro calls are never expanded and the
compile fails — so a file that imports `@conf-ts/macro` and one that doesn't are
effectively two different kinds of config. Don't mix a macro import into a file
that the build compiles in plain mode.

## The rules that actually bite

1. **The entry file must have a default export.** `export default {...}`,
   `export { cfg as default }`, and `export { default } from './x'` all work.
   Otherwise: `No default export found in the entry file`.
2. **Only `const` bindings can be referenced.** A referenced `let`/`var` is a
   hard error, even when its value is obviously constant.
3. **No runtime values.** Functions, `new Date()`, regex literals, and any other
   `new` expression are rejected (`Unsupported type: Function | Date | RegExp`).
   Object methods are silently dropped from the output rather than erroring.
4. **Macros only work when imported from `@conf-ts/macro`.** An unimported
   `String(...)` is just a call the compiler cannot evaluate; a locally shadowed
   `String` is left completely untouched. Aliases (`String as macroString`) and
   namespace imports (`macros.String`) do work.
5. **`expr()` takes a synchronous arrow function with an expression body**, one
   identifier parameter (or none), and must reach the context through a
   property: `ctx.user`, `ctx['user']`. Bare `ctx` is rejected. Block bodies,
   `function` expressions, `async`, and assignments are rejected.
6. **`exprTemplate()` branch pruning is opt-in.** Set
   `pruneExprTemplate: true` on `transform`/`transformProject`,
   `TypeScriptMacroTransformPlugin`, or `NativeMacroTransformPlugin` to replace
   a ternary whose condition depends only on template arguments and static
   constants with its selected branch. It defaults to `false` to preserve the
   original expression and avoid the extra analysis; conditions involving
   `ctx` or unsupported operations stay intact.
7. **Key ordering is not JS ordering by default.** `{ ...obj, b: 'new' }` moves
   `b` to the end. Preserving insertion order is a compile option the build
   sets — don't rely on either ordering unless you know which one is configured.

## Conventions

- **Name config entry files `*.conf.ts`.** That is the suffix build integrations
  match by default, and the generated `*.generated.json` / `*.generated.yaml`
  lands next to the source.
- **Never hand-edit generated JSON/YAML.** Change the `.conf.ts` and recompile.
  Both files are usually committed, so a hand edit silently diverges until the
  next build.
- **`@conf-ts/macro` is a compile-time dependency.** Keep it in
  `devDependencies` and never import it from application code. It warns on
  import and throws on every call at runtime — if you see that error, the
  transform didn't run.
- **Put shared constants and enums in their own modules and import them.** The
  compiler tracks only the files it actually evaluates, so unreached modules
  stay out of the dependency set and out of watch-mode invalidation.
- **Reference constants instead of repeating literals.** They fold to the same
  output, and inside `expr()` they fold into the emitted expression string, so
  there is no cost to naming a threshold.
- **Type the `expr()` context explicitly** — `expr<UserContext, boolean>(...)`
  — so the rule is type-checked against the shape the runtime will supply.
- **Read the whole compile error before editing.** It names the file, line,
  column, source line, and every `referenced from` hop in the re-export chain;
  the failure is usually in an imported module, not the entry file.

## References

Read the file that matches the task; each is self-contained.

| File                           | Covers                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `references/config-syntax.md` | Every supported/unsupported TypeScript construct, enum semantics, key ordering, JS serialization, multi-file and path aliases |
| `references/macros.md`        | `String`/`Number`/`Boolean`, `arrayMap`/`arrayFilter`/`arrayFlatMap`, `env`, nesting rules, import handling                   |
| `references/expr.md`          | `expr()`, `exprTemplate()`, optional/default parameters, opt-in branch pruning, composition, quoting, and emitted grammar     |
| `references/errors.md`        | Error message → cause → fix                                                                                                  |
