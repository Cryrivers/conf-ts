import { beforeAll, describe, expect, it, vi } from 'vitest';

let macro: typeof import('@conf-ts/macro');

function notTransformedError(name: string): string {
  return `'${name}' is a compile-time macro from '@conf-ts/macro' and must be expanded by the conf-ts macro transformer; it cannot run at runtime.`;
}

describe('Macro runtime helpers', () => {
  beforeAll(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      macro = await import('@conf-ts/macro');
    } finally {
      warn.mockRestore();
    }
  });

  it('throws when expr is called at runtime instead of being macro-expanded', () => {
    expect(() =>
      macro.expr<{ a: number; b: number }, boolean>(ctx => ctx.a > ctx.b),
    ).toThrow(notTransformedError('expr'));
  });

  it('throws when String/Number/Boolean are called at runtime', () => {
    expect(() => macro.String(1)).toThrow(notTransformedError('String'));
    expect(() => macro.Number('1')).toThrow(notTransformedError('Number'));
    expect(() => macro.Boolean(1)).toThrow(notTransformedError('Boolean'));
  });

  it('throws when array macros are called at runtime', () => {
    expect(() => macro.arrayMap([1], x => x)).toThrow(
      notTransformedError('arrayMap'),
    );
    expect(() => macro.arrayFlatMap([1], x => x)).toThrow(
      notTransformedError('arrayFlatMap'),
    );
    expect(() => macro.arrayFilter([1], () => true)).toThrow(
      notTransformedError('arrayFilter'),
    );
  });

  it('throws when env is called at runtime', () => {
    expect(() => macro.env('PATH')).toThrow(notTransformedError('env'));
  });
});
