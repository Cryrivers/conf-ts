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

export interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
  // Template literal payload when kind === 'template'
  // quasis.length === rawQuasis.length === expressionsSrc.length + 1
  template?: {
    quasis: string[];
    rawQuasis: string[];
    expressionsSrc: string[];
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

export interface LiteralNode {
  type: 'Literal';
  value: unknown;
}

export interface IdentifierNode {
  type: 'Identifier';
  name: string;
}

export interface UnaryNode {
  type: 'UnaryExpression';
  operator: '+' | '-' | '!' | '~' | 'void' | 'delete' | 'typeof';
  argument: ASTNode;
}

export interface BinaryNode {
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

export interface LogicalNode {
  type: 'LogicalExpression';
  operator: '&&' | '||' | '??';
  left: ASTNode;
  right: ASTNode;
}

export interface ConditionalNode {
  type: 'ConditionalExpression';
  test: ASTNode;
  consequent: ASTNode;
  alternate: ASTNode;
}

export interface ParenthesizedNode {
  type: 'ParenthesizedExpression';
  expression: ASTNode;
}

export interface ChainNode {
  type: 'ChainExpression';
  expression: ASTNode;
}

export interface MemberNode {
  type: 'MemberExpression';
  object: ASTNode;
  property: ASTNode; // Identifier or Literal(string/number)
  computed: boolean;
  // Whether this member access was created via optional chaining ("?.")
  optional?: boolean;
}

export interface CallNode {
  type: 'CallExpression';
  callee: ASTNode; // Identifier or MemberExpression
  args: ASTNode[];
  // Whether this call was created via optional chaining ("?.(")
  optional?: boolean;
}

export interface ArrayNode {
  type: 'ArrayExpression';
  elements: Array<ASTNode | SpreadElement>;
}

export interface ElisionNode {
  type: 'Elision';
}

export interface ObjectProperty {
  key: string; // identifier or string literal key; also used for shorthand (`{ a }`)
  computed?: false;
  value: ASTNode;
}

export interface ComputedObjectProperty {
  key: ASTNode; // evaluated at runtime and coerced to a property key, e.g. `{ [a]: b }`
  computed: true;
  value: ASTNode;
}

export interface ObjectNode {
  type: 'ObjectExpression';
  properties: Array<ObjectProperty | ComputedObjectProperty | SpreadElement>;
}

export interface SpreadElement {
  type: 'SpreadElement';
  argument: ASTNode;
}

export interface TemplateLiteralNode {
  type: 'TemplateLiteral';
  quasis: string[];
  rawQuasis: string[];
  expressions: ASTNode[];
}

export interface TaggedTemplateNode {
  type: 'TaggedTemplateExpression';
  tag: ASTNode; // Identifier or MemberExpression
  quasi: TemplateLiteralNode;
}

// One level of destructuring only: an object/array pattern's own elements
// must be plain (optionally defaulted, optionally renamed) identifiers, not
// further nested patterns.
export type ArrowParam =
  IdentifierParam | ObjectPatternParam | ArrayPatternParam | RestParam;

export interface IdentifierParam {
  kind: 'identifier';
  name: string;
  default?: ASTNode;
}

export interface ObjectPatternProperty {
  key: string;
  value: IdentifierParam;
}

export interface ObjectPatternParam {
  kind: 'object';
  properties: ObjectPatternProperty[];
  default?: ASTNode;
}

export interface ArrayPatternParam {
  kind: 'array';
  // `null` marks an elided ("hole") element, e.g. the middle slot in `[a, , b]`.
  elements: Array<IdentifierParam | null>;
  default?: ASTNode;
}

// Must be the last entry in `params`, and can only bind a plain identifier
// (matching real JS: `...rest` can't itself be destructured or defaulted).
export interface RestParam {
  kind: 'rest';
  name: string;
}

export interface ArrowFunctionNode {
  type: 'ArrowFunctionExpression';
  params: ArrowParam[];
  body: ASTNode;
}

export type Env = Record<string, unknown>;
