import type {
  ASTNode,
  BinaryNode,
  CallNode,
  Env,
  IdentifierNode,
  LiteralNode,
  LogicalNode,
  MemberNode,
  ObjectProperty,
  SpreadElement,
  UnaryNode,
} from './types';

const toBool = (v: unknown): boolean => !!v;
const toKey = (k: unknown): PropertyKey => (typeof k === 'symbol' ? k : String(k));

const getProp = (obj: unknown, key: PropertyKey): unknown => {
  if (obj === null || obj === undefined) {
    return null;
  }
  try {
    // Only string/number/symbol keys are meaningful; others stringify
    return (obj as Record<PropertyKey, unknown>)[key];
  } catch {
    return null;
  }
};

const evalMember = (node: MemberNode, env: Env): unknown => {
  const obj = evaluate(node.object, env);
  if (obj === null || obj === undefined) {
    // For optional chaining, missing object yields undefined like JS; otherwise null
    return node.optional ? undefined : null;
  }
  const key: PropertyKey = node.computed
    ? toKey(evaluate(node.property, env))
    : String((node.property as LiteralNode).value);
  return getProp(obj, key);
};

const evalCall = (node: CallNode, env: Env): unknown => {
  // determine this binding
  let fn: any;
  let thisArg: any = undefined;

  if (node.callee.type === 'MemberExpression') {
    const calleeMember = node.callee;
    thisArg = evaluate(calleeMember.object, env);
    if (thisArg === null || thisArg === undefined) {
      // Optional member access before call short-circuits to undefined
      return calleeMember.optional ? undefined : null;
    }
    const key: PropertyKey = calleeMember.computed
      ? toKey(evaluate(calleeMember.property, env))
      : String((calleeMember.property as LiteralNode).value);
    fn = getProp(thisArg, key);
  } else {
    fn = evaluate(node.callee, env);
  }

  if (typeof fn !== 'function') {
    // Keep engine's backward-compat behavior: non-callable returns null
    // For optional call (?.()), short-circuit to undefined when callee is nullish
    if (node.optional && (fn === null || fn === undefined)) {
      return undefined;
    }
    return null;
  }
  const args = node.args.map((a) => evaluate(a, env));
  try {
    return fn.apply(thisArg, args);
  } catch {
    return null;
  }
};

const evalIdentifier = (node: IdentifierNode, env: Env): unknown => {
  if (!env) {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(env, node.name) ? env[node.name] : null;
};

const evalUnary = (node: UnaryNode, env: Env): unknown => {
  const v = evaluate(node.argument, env);
  switch (node.operator) {
    case '!':
      return !toBool(v);
    case '+':
      // Non-standard: identity (matching test expectations)
      return v;
    case '-':
      return typeof v === 'number' ? -v : -Number(v);
  }
};

const evalBinary = (node: BinaryNode, env: Env): unknown => {
  const l = evaluate(node.left, env);
  const r = evaluate(node.right, env);
  switch (node.operator) {
    case '+':
      return (l as any) + (r as any);
    case '-':
      return (l as any) - (r as any);
    case '*':
      return (l as any) * (r as any);
    case '/':
      return (l as any) / (r as any);
    case '%':
      return (l as any) % (r as any);
    case '>':
      return (l as any) > (r as any);
    case '<':
      return (l as any) < (r as any);
    case '>=':
      return (l as any) >= (r as any);
    case '<=':
      return (l as any) <= (r as any);
    case '==':
      return l == r;
    case '!=':
      return l != r;
    case '===':
      return l === r;
    case '!==':
      return l !== r;
  }
};

const evalLogical = (node: LogicalNode, env: Env): unknown => {
  if (node.operator === '&&') {
    const left = evaluate(node.left, env);
    return toBool(left) ? evaluate(node.right, env) : false;
  }
  if (node.operator === '||') {
    const left = evaluate(node.left, env);
    return toBool(left) ? true : evaluate(node.right, env);
  }
  // null coalescing - ??
  const left = evaluate(node.left, env);
  return left === null || left === undefined ? evaluate(node.right, env) : left;
};

export const evaluate = (node: ASTNode, env: Env): unknown => {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return evalIdentifier(node, env);
    case 'UnaryExpression':
      return evalUnary(node, env);
    case 'BinaryExpression':
      return evalBinary(node, env);
    case 'LogicalExpression':
      return evalLogical(node, env);
    case 'ConditionalExpression': {
      const n = node;
      const test = evaluate(n.test, env);
      return toBool(test) ? evaluate(n.consequent, env) : evaluate(n.alternate, env);
    }
    case 'MemberExpression':
      return evalMember(node, env);
    case 'CallExpression':
      return evalCall(node, env);
    case 'ArrayExpression':
      return node.elements.map((el) => evaluate(el, env));
    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      for (const p of node.properties) {
        if ((p as SpreadElement).type === 'SpreadElement') {
          const src = evaluate((p as SpreadElement).argument, env);
          if (src && typeof src === 'object') {
            try {
              for (const k of Object.keys(src)) {
                obj[k] = (src as Record<string, unknown>)[k];
              }
            } catch {
              // ignore spread errors for robustness
            }
          }
        } else {
          const prop = p as ObjectProperty;
          obj[prop.key] = evaluate(prop.value, env);
        }
      }
      return obj;
    }
    case 'TemplateLiteral': {
      const cooked = node.quasis;
      const exprs = node.expressions.map((e) => evaluate(e, env));
      let out = cooked[0] ?? '';
      for (let i = 0; i < exprs.length; i++) {
        out += String(exprs[i]) + (cooked[i + 1] ?? '');
      }
      return out;
    }
    case 'TaggedTemplateExpression': {
      // Resolve tag function and this binding similar to CallExpression
      let fn: any;
      let thisArg: any = undefined;
      const tag = node.tag as any;
      if (tag.type === 'MemberExpression') {
        thisArg = evaluate(tag.object, env);
        if (thisArg === null || thisArg === undefined) {
          return null;
        }
        const key: PropertyKey = tag.computed
          ? toKey(evaluate(tag.property, env))
          : String((tag.property as LiteralNode).value);
        fn = getProp(thisArg, key);
      } else {
        fn = evaluate(tag, env);
      }
      if (typeof fn !== 'function') {
        return null;
      }
      const strings = [...node.quasi.quasis];
      // attach raw per JS semantics
      (strings as any).raw = [...node.quasi.rawQuasis];
      const values = node.quasi.expressions.map((e) => evaluate(e, env));
      try {
        return fn.apply(thisArg, [strings, ...values]);
      } catch {
        return null;
      }
    }
  }
};
