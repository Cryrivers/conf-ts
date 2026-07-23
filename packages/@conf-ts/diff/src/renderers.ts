import type { DiffChange, DiffReport } from './types.js';

const SYMBOLS: Record<DiffChange['kind'], string> = {
  add: '+',
  remove: '−',
  modify: '~',
  rename: '↪',
  move: '↕',
  reorder: '⇅',
  type: 'T',
  comment: '#',
  refactor: '◇',
};

function color(code: number, value: string, enabled: boolean) {
  return enabled ? `\u001B[${code}m${value}\u001B[0m` : value;
}

function changeColor(change: DiffChange) {
  if (change.classification === 'unknown') return 33;
  if (change.kind === 'add') return 32;
  if (change.kind === 'remove') return 31;
  if (change.kind === 'move' || change.kind === 'rename') return 36;
  if (change.classification === 'source-only') return 90;
  return 33;
}

function preview(value: unknown): string {
  if (value === undefined) return '';
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, undefined, 0);
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

function sourceLine(
  report: DiffReport,
  change: DiffChange,
  side: 'before' | 'after',
): string | undefined {
  const location = change.spans[side];
  if (!location) return undefined;
  const file = report.files.find(candidate =>
    side === 'before'
      ? candidate.pathBefore === location.file
      : candidate.pathAfter === location.file,
  );
  const source = side === 'before' ? file?.beforeSource : file?.afterSource;
  return source?.split(/\r?\n/)[location.line - 1]?.trim();
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function renderTerminal(
  report: DiffReport,
  options: { color?: boolean; showIgnored?: boolean } = {},
): string {
  const useColor =
    options.color ??
    (process.stdout.isTTY && process.env.NO_COLOR === undefined);
  const lines = [
    `${color(1, report.comparison.left.label, useColor)}  →  ${color(
      1,
      report.comparison.right.label,
      useColor,
    )}`,
    [
      color(1, `${report.summary.semantic} semantic`, useColor),
      `${report.summary.sourceOnly} source-only`,
      `${report.summary.unknown} unknown`,
      `${report.summary.ignored ?? 0} ignored`,
      `evaluation ${report.summary.evaluationStatus}`,
    ].join('  ·  '),
    '',
  ];

  for (const change of report.changes) {
    if (change.ignored && !options.showIgnored) continue;
    const pathBefore = change.pathBefore ?? '∅';
    const pathAfter = change.pathAfter ?? '∅';
    const path =
      pathBefore !== pathAfter
        ? `${pathBefore || '/'} → ${pathAfter || '/'}`
        : pathAfter || '/';
    const symbol = SYMBOLS[change.kind];
    lines.push(
      `${color(changeColor(change), symbol, useColor)} ${path}  ${color(
        2,
        `${change.classification}/${change.kind}`,
        useColor,
      )}`,
    );
    if (change.before || change.after) {
      lines.push(
        `    ${preview(change.before?.preview) || '∅'} → ${
          preview(change.after?.preview) || '∅'
        }`,
      );
    }
    const beforeLine = sourceLine(report, change, 'before');
    const afterLine = sourceLine(report, change, 'after');
    if (beforeLine !== undefined || afterLine !== undefined) {
      const columns = process.stdout.columns ?? 80;
      if (columns >= 110) {
        const width = Math.floor((columns - 7) / 2);
        const left = truncate(beforeLine ?? '', width).padEnd(width);
        const right = truncate(afterLine ?? '', width);
        lines.push(
          `    ${color(31, left, useColor)} │ ${color(32, right, useColor)}`,
        );
      } else {
        if (beforeLine !== undefined)
          lines.push(`    ${color(31, `- ${beforeLine}`, useColor)}`);
        if (afterLine !== undefined)
          lines.push(`    ${color(32, `+ ${afterLine}`, useColor)}`);
      }
    }
  }

  if (report.diagnostics.length > 0) {
    lines.push('', color(1, 'Diagnostics', useColor));
    for (const diagnostic of report.diagnostics) {
      const location = diagnostic.location
        ? ` ${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}`
        : '';
      lines.push(
        `${color(
          diagnostic.severity === 'error' ? 31 : 33,
          diagnostic.severity.toUpperCase(),
          useColor,
        )} ${diagnostic.code}${location} — ${diagnostic.message}`,
      );
    }
  }
  return lines.join('\n');
}

export function renderSarif(report: DiffReport): string {
  const results = [
    ...report.changes
      .filter(
        change => !change.ignored && change.classification !== 'source-only',
      )
      .map(change => {
        const location = change.spans.after ?? change.spans.before;
        return {
          ruleId: `conf-ts-diff/${change.classification}/${change.kind}`,
          level: change.classification === 'unknown' ? 'warning' : 'note',
          message: {
            text: `${change.kind} at ${
              change.pathAfter ?? change.pathBefore ?? '/'
            }`,
          },
          locations: location
            ? [
                {
                  physicalLocation: {
                    artifactLocation: { uri: location.file },
                    region: {
                      startLine: location.line,
                      startColumn: location.column,
                      endLine: location.endLine,
                      endColumn: location.endColumn,
                    },
                  },
                },
              ]
            : [],
          properties: {
            changeId: change.id,
            classification: change.classification,
            pathBefore: change.pathBefore,
            pathAfter: change.pathAfter,
            sensitive: change.sensitive,
          },
        };
      }),
    ...report.diagnostics.map(diagnostic => ({
      ruleId: `conf-ts-diff/${diagnostic.code}`,
      level:
        diagnostic.severity === 'error'
          ? 'error'
          : diagnostic.severity === 'warning'
            ? 'warning'
            : 'note',
      message: { text: diagnostic.message },
      locations: diagnostic.location
        ? [
            {
              physicalLocation: {
                artifactLocation: { uri: diagnostic.location.file },
                region: {
                  startLine: diagnostic.location.line,
                  startColumn: diagnostic.location.column,
                },
              },
            },
          ]
        : [],
    })),
  ];
  return JSON.stringify(
    {
      version: '2.1.0',
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      runs: [
        {
          tool: {
            driver: {
              name: '@conf-ts/diff',
              version: '0.0.17',
              informationUri: 'https://github.com/Cryrivers/conf-ts',
              rules: [],
            },
          },
          results,
        },
      ],
    },
    undefined,
    2,
  );
}
