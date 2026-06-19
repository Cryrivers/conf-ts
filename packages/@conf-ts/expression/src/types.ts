export type Env = Record<string, unknown>;

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
  | MemberNode
  | CallNode
  | ArrayNode
  | ObjectNode
  | TemplateLiteralNode
  | TaggedTemplateNode;

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
  operator: '+' | '-' | '!';
  argument: ASTNode;
}

export interface BinaryNode {
  type: 'BinaryExpression';
  operator: '+' | '-' | '*' | '/' | '%' | '>' | '<' | '>=' | '<=' | '==' | '!=' | '===' | '!==';
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
  elements: ASTNode[];
}

export interface ObjectProperty {
  key: string; // only identifier or string literal keys are supported
  value: ASTNode;
}

export interface ObjectNode {
  type: 'ObjectExpression';
  properties: Array<ObjectProperty | SpreadElement>;
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
