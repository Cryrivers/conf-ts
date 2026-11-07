export type TokenKind =
  | 'number'
  | 'string'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'identifier'
  | 'punct'
  | 'operator'
  | 'template'
  | 'eof';

/**
 * A span of the parsed source: `start` is the offset of its first character
 * and `end` the offset just past its last one, so `source.slice(start, end)`
 * is its text and an empty span (e.g. at the end of input) has
 * `start === end`.
 */
export interface SourceRange {
  start: number;
  end: number;
}

/**
 * The source span of something `parse()` produced: every node, spread
 * element, object property, and arrow parameter, measured in the parsed
 * string (including inside template literal interpolations). Optional so that
 * nodes built by hand, e.g. for `print()`, can leave it out.
 */
export type NodeRange = Partial<SourceRange>;

export interface Token extends SourceRange {
  kind: TokenKind;
  value: string;
  // Template literal payload when kind === 'template'
  // quasis.length === rawQuasis.length === expressionsSrc.length + 1
  template?: {
    quasis: string[];
    rawQuasis: string[];
    expressionsSrc: string[];
    /** Where each `expressionsSrc` entry starts, measured like `start`. */
    expressionsStart: number[];
  };
}

export type ASTNode =
  | LiteralNode
  | IdentifierNode
  | UnaryNode
  | BinaryNode
  | LogicalNode
  | ConditionalNode
  | ParenthesizedNode
  | ChainNode
  | MemberNode
  | CallNode
  | ArrayNode
  | ElisionNode
  | ObjectNode
  | TemplateLiteralNode
  | TaggedTemplateNode
  | ArrowFunctionNode;

export interface LiteralNode extends NodeRange {
  type: 'Literal';
  value: unknown;
  /**
   * The literal's source text as written, e.g. `1e3` or `'a'` (quotes
   * included); for the property of a non-computed member access, the
   * property name. Set by `parse()`; `print()` prints `value` instead.
   */
  raw?: string;
}

export interface IdentifierNode extends NodeRange {
  type: 'Identifier';
  name: string;
}

export interface UnaryNode extends NodeRange {
  type: 'UnaryExpression';
  operator: '+' | '-' | '!' | '~' | 'void' | 'delete' | 'typeof';
  argument: ASTNode;
}

export interface BinaryNode extends NodeRange {
  type: 'BinaryExpression';
  operator:
    | '+'
    | '-'
    | '*'
    | '**'
    | '/'
    | '%'
    | '&'
    | '|'
    | '^'
    | '<<'
    | '>>'
    | '>>>'
    | '>'
    | '<'
    | '>='
    | '<='
    | '=='
    | '!='
    | '==='
    | '!=='
    | 'instanceof'
    | 'in';
  left: ASTNode;
  right: ASTNode;
}

export interface LogicalNode extends NodeRange {
  type: 'LogicalExpression';
  operator: '&&' | '||' | '??';
  left: ASTNode;
  right: ASTNode;
}

export interface ConditionalNode extends NodeRange {
  type: 'ConditionalExpression';
  test: ASTNode;
  consequent: ASTNode;
  alternate: ASTNode;
}

export interface ParenthesizedNode extends NodeRange {
  type: 'ParenthesizedExpression';
  expression: ASTNode;
}

// Wraps a whole member/call chain that contains an optional link (`?.`), so
// the link short-circuits the rest of the chain to `undefined`.
export interface ChainNode extends NodeRange {
  type: 'ChainExpression';
  expression: ASTNode;
}

export interface MemberNode extends NodeRange {
  type: 'MemberExpression';
  object: ASTNode;
  property: ASTNode; // Identifier or Literal(string/number)
  computed: boolean;
  // Whether this member access was created via optional chaining ("?.")
  optional?: boolean;
}

export interface CallNode extends NodeRange {
  type: 'CallExpression';
  callee: ASTNode; // Identifier or MemberExpression
  args: ASTNode[];
  // Whether this call was created via optional chaining ("?.(")
  optional?: boolean;
}

export interface ArrayNode extends NodeRange {
  type: 'ArrayExpression';
  elements: Array<ASTNode | SpreadElement>;
}

// A hole in an array literal, e.g. the middle slot in `[a, , b]`; its range
// is the comma that ends it.
export interface ElisionNode extends NodeRange {
  type: 'Elision';
}

export interface ObjectProperty extends NodeRange {
  key: string; // identifier or string literal key; also used for shorthand (`{ a }`)
  computed?: false;
  value: ASTNode;
}

export interface ComputedObjectProperty extends NodeRange {
  key: ASTNode; // evaluated at runtime and coerced to a property key, e.g. `{ [a]: b }`
  computed: true;
  value: ASTNode;
}

export interface ObjectNode extends NodeRange {
  type: 'ObjectExpression';
  properties: Array<ObjectProperty | ComputedObjectProperty | SpreadElement>;
}

export interface SpreadElement extends NodeRange {
  type: 'SpreadElement';
  argument: ASTNode;
}

export interface TemplateLiteralNode extends NodeRange {
  type: 'TemplateLiteral';
  quasis: string[];
  rawQuasis: string[];
  expressions: ASTNode[];
}

export interface TaggedTemplateNode extends NodeRange {
  type: 'TaggedTemplateExpression';
  tag: ASTNode; // Identifier or MemberExpression
  quasi: TemplateLiteralNode;
}

// One level of destructuring only: an object/array pattern's own elements
// must be plain (optionally defaulted, optionally renamed) identifiers, not
// further nested patterns.
export type ArrowParam =
  IdentifierParam | ObjectPatternParam | ArrayPatternParam | RestParam;

export interface IdentifierParam extends NodeRange {
  kind: 'identifier';
  name: string;
  default?: ASTNode;
}

export interface ObjectPatternProperty extends NodeRange {
  key: string;
  value: IdentifierParam;
}

export interface ObjectPatternParam extends NodeRange {
  kind: 'object';
  properties: ObjectPatternProperty[];
  default?: ASTNode;
}

export interface ArrayPatternParam extends NodeRange {
  kind: 'array';
  // `null` marks an elided ("hole") element, e.g. the middle slot in `[a, , b]`.
  elements: Array<IdentifierParam | null>;
  default?: ASTNode;
}

// Must be the last entry in `params`, and can only bind a plain identifier
// (matching real JS: `...rest` can't itself be destructured or defaulted).
export interface RestParam extends NodeRange {
  kind: 'rest';
  name: string;
}

export interface ArrowFunctionNode extends NodeRange {
  type: 'ArrowFunctionExpression';
  params: ArrowParam[];
  body: ASTNode;
}

export type Env = Record<string, unknown>;
