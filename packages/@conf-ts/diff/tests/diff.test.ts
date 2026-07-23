import { describe, expect, it } from 'vitest';

import {
  diffProjects,
  policyFails,
  renderHtml,
  renderSarif,
  renderTerminal,
  type SourceProject,
} from '../src/index.js';

function project(code: string): SourceProject {
  return {
    filename: '/virtual/config.conf.ts',
    code,
    files: { '/virtual/config.conf.ts': code },
  };
}

describe('@conf-ts/diff', () => {
  it('reports semantic object changes with source locations', () => {
    const report = diffProjects(
      project('export default { service: { port: 80 } };'),
      project('export default { service: { port: 443 } };'),
    );

    expect(report.summary.semantic).toBe(1);
    expect(report.changes[0]).toMatchObject({
      classification: 'semantic',
      kind: 'modify',
      pathAfter: '/service/port',
    });
    expect(report.changes[0].spans.after?.line).toBe(1);
  });

  it('detects keyed array moves and keeps object order source-only', () => {
    const moves = diffProjects(
      project(`export default [{ id: 'a' }, { id: 'b' }];`),
      project(`export default [{ id: 'b' }, { id: 'a' }];`),
    );
    expect(moves.summary.moved).toBe(2);

    const reorder = diffProjects(
      project('export default { a: 1, b: 2 };'),
      project('export default { b: 2, a: 1 };'),
    );
    expect(reorder.summary.semantic).toBe(0);
    expect(reorder.summary.sourceOnly).toBeGreaterThan(0);
  });

  it('detects unambiguous object renames with stable change IDs', () => {
    const before = project('export default { oldName: { port: 80 } };');
    const after = project('export default { newName: { port: 80 } };');
    const first = diffProjects(before, after);
    const second = diffProjects(before, after);
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({
      kind: 'rename',
      pathBefore: '/oldName',
      pathAfter: '/newName',
    });
    expect(first.changes[0].id).toBe(second.changes[0].id);
  });

  it('bounds ambiguous array matching and reports deterministic degradation', () => {
    const values = Array.from({ length: 16 }, (_, index) => index);
    const before = project(
      `export default [${values.map(value => `{ value: ${value} }`).join(',')}];`,
    );
    const after = project(
      `export default [${[...values]
        .reverse()
        .map(value => `{ value: ${value} }`)
        .join(',')}];`,
    );
    const report = diffProjects(before, after, { maxMatchWork: 1 });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'matching-degraded' }),
    );
    expect(report.changes.map(change => change.pathAfter)).toEqual(
      diffProjects(before, after, { maxMatchWork: 1 }).changes.map(
        change => change.pathAfter,
      ),
    );
  });

  it('supports ignore and policy rules', () => {
    const report = diffProjects(
      project('export default { generatedAt: 1, stable: true };'),
      project('export default { generatedAt: 2, stable: true };'),
      { ignore: ['/generatedAt'] },
    );
    expect(report.summary.ignored).toBe(1);
    expect(policyFails(report, 'any')).toBe(false);
  });

  it('redacts env-derived values from every serializable renderer', () => {
    const left = project(`
      import { env } from '@conf-ts/macro';
      export default { secret: env('TOKEN') };
    `);
    const right = project(`
      import { env } from '@conf-ts/macro';
      export default { secret: env('TOKEN') };
    `);
    const report = diffProjects(left, right, {
      macro: { env: { TOKEN: 'super-secret-left' } },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('super-secret-left');
    expect(renderHtml(report)).not.toContain('super-secret-left');
    expect(renderSarif(report)).not.toContain('super-secret-left');
  });

  it('redacts configured paths from values and embedded raw source', () => {
    const leftSecret = 'left-inline-secret';
    const rightSecret = 'right-inline-secret';
    const report = diffProjects(
      project(`export default { secret: '${leftSecret}', public: true };`),
      project(`export default { secret: '${rightSecret}', public: true };`),
      { redact: ['/secret'] },
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(leftSecret);
    expect(serialized).not.toContain(rightSecret);
    expect(serialized).toContain('/* redacted */ undefined');
    expect(renderHtml(report)).not.toContain(leftSecret);
    expect(renderSarif(report)).not.toContain(rightSecret);
  });

  it('produces a self-contained interactive HTML report', () => {
    const report = diffProjects(
      project('export default { enabled: false };'),
      project('export default { enabled: true };'),
    );
    const html = renderHtml(report);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('view-dependencies');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('returns a partial unknown report when one side cannot be parsed', () => {
    const report = diffProjects(
      project('export default { broken: '),
      project('export default { broken: false };'),
    );
    expect(report.summary).toMatchObject({
      unknown: 1,
      evaluationStatus: 'partial',
    });
    expect(report.changes[0]).toMatchObject({
      classification: 'unknown',
    });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'parse-error',
      }),
    );
  });

  it('includes source context in terminal output', () => {
    const report = diffProjects(
      project('export default { enabled: false };'),
      project('export default { enabled: true };'),
    );
    const output = renderTerminal(report, { color: false });
    expect(output).toContain('- export default { enabled: false };');
    expect(output).toContain('+ export default { enabled: true };');
  });
});
