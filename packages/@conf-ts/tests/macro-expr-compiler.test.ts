import { compileInMemory as compileJs } from '@conf-ts/compiler';
import { compileInMemory as compileNative } from '@conf-ts/compiler-native';
import expression from '@conf-ts/expression';
import { describe, expect, it } from 'vitest';

const callbackError =
  'expr callback must be an arrow function with a single identifier parameter and expression body';

const compilers = [
  ['compiler', compileJs],
  ['compiler-native', compileNative],
] as const;

describe.each(compilers)('%s expr macro', (_name, compileInMemory) => {
  function compileConfig(source: string): Record<string, any> {
    const { output } = compileInMemory(
      { '/index.ts': source },
      '/index.ts',
      'json',
      true,
    );
    return JSON.parse(output);
  }

  function expectCompileError(source: string, message: string) {
    expect(() => compileConfig(source)).toThrow(message);
  }

  it('converts context property access into expression strings', () => {
    const output = compileConfig(`
      import { expr } from '@conf-ts/macro';

      export default {
        simple: expr<{ a: number; b: number }, boolean>(ctx => ctx.a > ctx.b),
        nested: expr<{ user: { age: number }; limit: number }, boolean>(
          ctx => ctx.user.age >= ctx.limit,
        ),
        computed: expr<{ a: number }, number>(ctx => ctx['a']),
      };
    `);

    expect(output).toEqual({
      simple: 'a > b',
      nested: 'user.age >= limit',
      computed: 'a',
    });
  });

  it('returns output consumable by @conf-ts/expression', () => {
    const output = compileConfig(`
      import { expr } from '@conf-ts/macro';

      export default {
        rule: expr<{ a: number; b: number }, boolean>(ctx => ctx.a > ctx.b),
      };
    `);
    const compiled = expression(output.rule);

    expect(compiled({ a: 2, b: 1 })).toBe(true);
    expect(compiled({ a: 1, b: 2 })).toBe(false);
  });

  it('rejects block bodies', () => {
    expectCompileError(
      `
        import { expr } from '@conf-ts/macro';

        export default {
          rule: expr<{ a: number }, number>(ctx => {
            return ctx.a;
          }),
        };
      `,
      callbackError,
    );
  });

  it('rejects function expressions', () => {
    expectCompileError(
      `
        import { expr } from '@conf-ts/macro';

        export default {
          rule: expr(function (ctx) {
            return ctx.a;
          }),
        };
      `,
      callbackError,
    );
  });

  it('rejects async arrows', () => {
    expectCompileError(
      `
        import { expr } from '@conf-ts/macro';

        export default {
          rule: expr(async ctx => ctx.a),
        };
      `,
      callbackError,
    );
  });

  it('rejects direct context parameter usage', () => {
    expectCompileError(
      `
        import { expr } from '@conf-ts/macro';

        export default {
          rule: expr<{ a: number }, { a: number }>(ctx => ctx),
        };
      `,
      'expr callback cannot use the context parameter directly',
    );
  });

  it('rejects dynamic root context access', () => {
    expectCompileError(
      `
        import { expr } from '@conf-ts/macro';

        const key = 'a';

        export default {
          rule: expr<{ a: number }, number>(ctx => ctx[key]),
        };
      `,
      'expr callback can only access context properties with identifier property names',
    );
  });

  it('rejects syntax unsupported by @conf-ts/expression', () => {
    expectCompileError(
      `
        import { expr } from '@conf-ts/macro';

        export default {
          rule: expr<{ a: number }, number>(ctx => ctx.a ** 2),
        };
      `,
      'parse expression error',
    );
  });

  it('requires expr to be imported from @conf-ts/macro', () => {
    expectCompileError(
      `
        export default {
          rule: expr((ctx) => ctx.a),
        };
      `,
      "Macro function 'expr' must be imported from '@conf-ts/macro' to use in macro mode",
    );
  });
});
