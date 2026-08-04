import {
  arrayMap,
  expr,
  exprTemplate,
  modifier,
} from '@conf-ts/macro';

type Context = {
  a: boolean;
  b: boolean;
  c: boolean;
  score: number;
};
type Rule = (ctx: Context) => boolean;
type OptionalRuleInput = {
  readonly expression?: Rule;
  readonly label: string;
};

const primary = expr<Context, boolean>(ctx => ctx.a || ctx.b);
const secondary = expr<Context, boolean>(ctx => ctx.c || ctx.score > 0);
const minimum = expr<Context, boolean>(ctx => ctx.score >= 10);

const withOptional = modifier<
  [OptionalRuleInput],
  OptionalRuleInput & { expression: Rule }
>(input => ({
  ...input,
  expression: input.expression
    ? expr<Context, boolean>(
        ctx => input.expression!(ctx) && secondary(ctx),
      )
    : secondary,
}));

const direct = modifier<[Rule], Rule>(expression =>
  expr<Context, boolean>(ctx => expression(ctx) && secondary(ctx)),
);

const computedProperty = modifier<[{ expression: Rule }], Rule>(input =>
  expr<Context, boolean>(
    ctx => input['expression'](ctx) && secondary(ctx),
  ),
);

const nestedProperty = modifier<
  [{ nested: { expression: Rule } }],
  Rule
>(input =>
  expr<Context, boolean>(
    ctx => input.nested.expression(ctx) && secondary(ctx),
  ),
);

const optionalNestedProperty = modifier<
  [{ readonly nested?: { readonly expression?: Rule } }],
  Rule
>(input =>
  input.nested?.expression
    ? expr<Context, boolean>(
        ctx => input.nested!.expression!(ctx) && secondary(ctx),
      )
    : secondary,
);

const multipleProperties = modifier<
  [{ left: Rule; right: Rule }],
  Rule
>(input =>
  expr<Context, boolean>(ctx => input.left(ctx) && input.right(ctx)),
);

const booleanGate = modifier<
  [{ enabled: boolean; expression: Rule }],
  Rule
>(input =>
  input.enabled
    ? expr<Context, boolean>(
        ctx => input.expression(ctx) && secondary(ctx),
      )
    : input.expression,
);

const expressionAndNumber = modifier<
  [{ expression: Rule; minimum: number }],
  Rule
>(input =>
  expr<Context, boolean>(
    ctx => input.expression(ctx) && ctx.score >= input.minimum,
  ),
);

const destructuredProperty = modifier<[{ expression: Rule }], Rule>(
  ({ expression: renamed }) =>
    expr<Context, boolean>(ctx => renamed(ctx) && secondary(ctx)),
);

const arrayElements = modifier<[[Rule, Rule]], Rule>(expressions =>
  expr<Context, boolean>(
    ctx => expressions[0](ctx) && expressions[1](ctx),
  ),
);

const destructuredArray = modifier<[[Rule, Rule]], Rule>(([first, second]) =>
  expr<Context, boolean>(ctx => first(ctx) && second(ctx)),
);

const restRules = modifier<[...Rule[]], Rule>((...expressions) =>
  expr<Context, boolean>(
    ctx => expressions[0](ctx) && expressions[1](ctx),
  ),
);

const defaultRule = modifier<[Rule?], Rule>((expression = secondary) =>
  expr<Context, boolean>(ctx => expression(ctx) && minimum(ctx)),
);

const wrapRule = modifier<[Rule], OptionalRuleInput>(expression => ({
  expression,
  label: 'nested',
}));
const nestedModifiers = modifier<[Rule], OptionalRuleInput>(expression =>
  withOptional(wrapRule(expression)),
);

const templated = exprTemplate<Context, boolean, [Rule]>(
  (ctx, expression) => expression(ctx) && secondary(ctx),
);

const staticInput = {
  expression: primary,
  label: 'local-const',
};
const staticRules = [primary, secondary] as const;

export default {
  optionalPresent: withOptional({
    expression: primary,
    label: 'present',
  }),
  optionalAbsent: withOptional({ label: 'absent' }),
  direct: direct(primary),
  computedProperty: computedProperty({ expression: primary }),
  nestedProperty: nestedProperty({
    nested: { expression: primary },
  }),
  optionalNestedPresent: optionalNestedProperty({
    nested: { expression: primary },
  }),
  optionalNestedAbsent: optionalNestedProperty({}),
  multipleProperties: multipleProperties({
    left: primary,
    right: secondary,
  }),
  booleanGateOn: booleanGate({
    enabled: true,
    expression: primary,
  }),
  booleanGateOff: booleanGate({
    enabled: false,
    expression: primary,
  }),
  expressionAndNumber: expressionAndNumber({
    expression: primary,
    minimum: 7,
  }),
  destructuredProperty: destructuredProperty({ expression: primary }),
  arrayElements: arrayElements([primary, secondary]),
  destructuredArray: destructuredArray([primary, secondary]),
  restRules: restRules(...staticRules),
  defaultRuleOmitted: defaultRule(),
  defaultRuleProvided: defaultRule(primary),
  nestedModifiers: nestedModifiers(primary),
  localConstArgument: withOptional(staticInput),
  inlineArgument: withOptional({
    expression: primary,
    label: 'inline',
  }),
  arrayMacro: arrayMap([primary, secondary], expression =>
    defaultRule(expression),
  ),
  exprTemplateArgument: templated(primary),
};
