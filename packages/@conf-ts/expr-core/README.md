## @conf-ts/expr-core

The lexer, parser, printer, and AST utilities of the conf-ts expression language, plus the `Expr`/`LooseExpr` types. [`@conf-ts/expression`](../expression) evaluates the trees this package parses, and re-exports all of it as `@conf-ts/expression/core`: tooling that already depends on `@conf-ts/expression` can import from there, without its own dependency and with the very same module (so `instanceof ExprSyntaxError` holds for errors thrown by `expression()`).

See the [`@conf-ts/expression` README](../expression/README.md#supported-syntax) for the grammar.

### Parsing

```ts
import { tryParse } from '@conf-ts/expression/core';

const result = tryParse('user.age >= limit');
if (result.ok) {
  result.ast; // { type: 'BinaryExpression', operator: '>=', start: 0, end: 17, ... }
} else {
  const { detail, start, end } = result.error; // e.g. for squiggles in an editor
}
```

`parse(tokenize(source), source)` returns the same tree but throws an `ExprSyntaxError` instead. The error's `message` keeps the long-standing `parse expression error: …` / `invalid expression: …` text; `detail` says what is wrong (`unexpected token ")", expected an expression`, `unterminated string literal`, …), `start`/`end` locate it as offsets into the source (`end` exclusive, equal to `start` at the end of input), and `token` is the rejected token when the parser found the error.

Every token, AST node, spread element, object property, and arrow parameter carries its `start`/`end` range, measured in the parsed string, including inside template literal interpolations. Tokens and literals also keep their source text as `raw` (`1e3`, `'a'`). On AST objects both are optional in the types, so hand-built nodes can leave them out.

### Printing

`print(node, { quote })` turns a tree back into source text that parses to the same tree, give or take parentheses — for rewriting expressions (negating a condition, folding known values, joining clauses) or building them from scratch:

```ts
import { print, type ASTNode } from '@conf-ts/expression/core';

const not = (argument: ASTNode): ASTNode => ({
  type: 'UnaryExpression',
  operator: '!',
  argument,
});
const a: ASTNode = { type: 'Identifier', name: 'a' };
const b: ASTNode = { type: 'Identifier', name: 'b' };

print(not({ type: 'LogicalExpression', operator: '&&', left: a, right: b })); // '!(a && b)'
print({
  type: 'LogicalExpression',
  operator: '||',
  left: not(a),
  right: not(b),
}); // '!a || !b'
```

`ParenthesizedExpression` nodes are printed as written; otherwise parentheses are added only where precedence, associativity, or an optional chain's extent requires them, and where JavaScript would misread the text (`(a || b) ?? c`, `(-a) ** b`, `x => ({a: 1})`). Strings use double quotes unless `quote: 'single'` is passed. Source ranges and `raw` are ignored, so edit `value`, not `raw`. A tree with no source form, such as an `Identifier` named `a-b` or a `Literal` holding an object, throws a `TypeError`. Template literals are printed from `rawQuasis`.

### Traversing

- `forEachChild(node, visit)` / `getChildren(node)`: a node's child expressions in evaluation order. Non-computed property names (`b` in `a.b`) are not children, spread elements are visited as their argument, and an arrow function's children are its parameter defaults followed by its body.
- `collectFreeIdentifiers(node)`: every `Identifier` that reads the evaluation environment, i.e. not bound by an enclosing arrow function's parameters, with its range. A parameter default only sees the parameters before it.
- `forEachParamBinding(params, onDefault, onBind)`: the order in which an arrow function evaluates its parameter defaults and binds its parameter names, for scope analysis of your own.
