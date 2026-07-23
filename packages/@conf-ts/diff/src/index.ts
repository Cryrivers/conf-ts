import { createHash } from 'node:crypto';
import { compile } from '@conf-ts/compiler-native';
import { diffProjects as nativeDiffProjects } from '@conf-ts/diff-native';
import {
  scanReferencedModules,
  transformProject,
} from '@conf-ts/macro-transformer-native';

import { resolveDiffSource } from './project.js';
import { renderHtml } from './report.js';
import type {
  DiffChange,
  DiffOptions,
  DiffReport,
  DiffSource,
  SourceProject,
} from './types.js';

export type * from './types.js';
export { renderHtml } from './report.js';
export { renderSarif, renderTerminal } from './renderers.js';

interface EvaluationResult {
  value?: unknown;
  dependencies: string[];
  error?: string;
  sensitive: boolean;
  expandedSource?: string;
}

const TERMINAL_REVEAL = Symbol.for('@conf-ts/diff/terminal-reveal');

function macroImported(files: Record<string, string>): boolean {
  return Object.values(files).some(code =>
    /(?:from\s*|import\s*)['"]@conf-ts\/macro['"]/.test(code),
  );
}

function envMacroUsed(files: Record<string, string>): boolean {
  return (
    macroImported(files) &&
    Object.values(files).some(code => /\benv\s*\(/.test(code))
  );
}

function normalizeProject(
  project: SourceProject,
): Required<Pick<SourceProject, 'filename' | 'code' | 'files'>> &
  SourceProject {
  return {
    ...project,
    files: {
      ...(project.files ?? {}),
      [project.filename]: project.code,
    },
  };
}

function evaluateProject(
  source: SourceProject,
  options: DiffOptions,
): EvaluationResult {
  const project = normalizeProject(source);
  const mode = options.macro?.mode ?? 'auto';
  const shouldTransform =
    mode === 'always' || (mode === 'auto' && macroImported(project.files));
  let files = { ...project.files };
  let dependencies = [...(project.dependencies ?? [])];
  try {
    if (shouldTransform) {
      const transformed = transformProject(
        {
          project: {
            files,
            resolutions: project.resolutions,
            compilerOptions: project.compilerOptions,
            entryFiles: [project.filename],
            dependencies,
            referencedModules:
              project.referencedModules ?? scanReferencedModules(files),
          },
        },
        {
          env: options.macro?.env ?? {},
          inheritProcessEnv: false,
          sourceMap: true,
        },
      );
      for (const [filename, result] of Object.entries(
        transformed.transformed,
      )) {
        files[filename] = result.code;
      }
      dependencies = [
        ...new Set([...dependencies, ...transformed.dependencies]),
      ];
    }
    const result = compile(
      {
        filename: project.filename,
        code: files[project.filename] ?? project.code,
        project: {
          files,
          resolutions: project.resolutions,
          compilerOptions: project.compilerOptions,
        },
      },
      'json',
    );
    return {
      value: JSON.parse(result.output),
      dependencies: [...new Set([...dependencies, ...result.dependencies])],
      sensitive: shouldTransform && envMacroUsed(project.files),
      expandedSource: shouldTransform ? files[project.filename] : undefined,
    };
  } catch (error) {
    return {
      dependencies,
      error: error instanceof Error ? error.message : String(error),
      sensitive: shouldTransform && envMacroUsed(project.files),
    };
  }
}

export function pointerMatches(pattern: string, value: string): boolean {
  const patternParts = pattern.split('/').slice(1);
  const valueParts = value.split('/').slice(1);
  const match = (patterns: string[], values: string[]): boolean => {
    const [head, ...tail] = patterns;
    if (head === undefined) return values.length === 0;
    if (head === '**') {
      return (
        match(tail, values) ||
        (values.length > 0 && match(patterns, values.slice(1)))
      );
    }
    return (
      values.length > 0 &&
      (head === '*' || head === values[0]) &&
      match(tail, values.slice(1))
    );
  };
  return match(patternParts, valueParts);
}

function redactEvaluation(
  value: unknown,
  patterns: string[],
  currentPath = '',
): unknown {
  if (patterns.some(pattern => pointerMatches(pattern, currentPath))) {
    return '••••••';
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactEvaluation(item, patterns, `${currentPath}/${index}`),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactEvaluation(
          item,
          patterns,
          `${currentPath}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        ),
      ]),
    );
  }
  return value;
}

function applyIgnore(report: DiffReport, patterns: string[]): void {
  for (const change of report.changes) {
    const path = change.pathAfter ?? change.pathBefore ?? '';
    change.ignored = patterns.some(pattern => pointerMatches(pattern, path));
  }
  const active = report.changes.filter(change => !change.ignored);
  report.summary.total = active.length;
  report.summary.semantic = active.filter(
    change => change.classification === 'semantic',
  ).length;
  report.summary.sourceOnly = active.filter(
    change => change.classification === 'source-only',
  ).length;
  report.summary.unknown = active.filter(
    change => change.classification === 'unknown',
  ).length;
  report.summary.ignored = report.changes.length - active.length;
}

function sourceSnippet(
  source: string | undefined,
  start: number | undefined,
  end: number | undefined,
) {
  if (source === undefined || start === undefined || end === undefined)
    return '';
  return source.slice(start, end);
}

function comments(text: string) {
  return [...text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)]
    .map(match => match[0].replace(/\s+/g, ' ').trim())
    .join('|');
}

function classifySourceOnly(report: DiffReport): void {
  const file = report.files[0];
  for (const change of report.changes) {
    if (change.classification !== 'source-only' || change.kind !== 'refactor') {
      continue;
    }
    const before = sourceSnippet(
      file?.beforeSource,
      change.spans.before?.start,
      change.spans.before?.end,
    );
    const after = sourceSnippet(
      file?.afterSource,
      change.spans.after?.start,
      change.spans.after?.end,
    );
    if (comments(before) !== comments(after)) {
      change.kind = 'comment';
    } else if (
      /\b(?:as|satisfies)\b|:\s*[A-Za-z_$][\w$<>{}\[\]|&., ]*/.test(
        `${before}\n${after}`,
      )
    ) {
      change.kind = 'type';
    }
  }
}

function collectRedactedSpans(
  node: DiffReport['structure']['before'],
  patterns: string[],
  spans: Map<string, Array<{ start: number; end: number }>>,
): void {
  if (!node) return;
  if (patterns.some(pattern => pointerMatches(pattern, node.path))) {
    const fileSpans = spans.get(node.span.file) ?? [];
    fileSpans.push({ start: node.span.start, end: node.span.end });
    spans.set(node.span.file, fileSpans);
    return;
  }
  for (const child of node.children) {
    collectRedactedSpans(child, patterns, spans);
  }
}

function redactSource(
  source: string | undefined,
  spans: Array<{ start: number; end: number }> | undefined,
): string | undefined {
  if (source === undefined || !spans?.length) return source;
  let result = source;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const removed = result.slice(span.start, span.end);
    const lineBreaks = removed.match(/\r?\n/g)?.join('') ?? '';
    result = `${result.slice(0, span.start)}/* redacted */ undefined${lineBreaks}${result.slice(span.end)}`;
  }
  return result;
}

function redactStructureValues(
  node: DiffReport['structure']['before'],
  patterns: string[],
  inherited = false,
): void {
  if (!node) return;
  const redacted =
    inherited || patterns.some(pattern => pointerMatches(pattern, node.path));
  if (redacted && node.valuePreview !== undefined) {
    node.valuePreview = '••••••';
  }
  for (const child of node.children) {
    redactStructureValues(child, patterns, redacted);
  }
}

function redactReportSources(report: DiffReport, patterns: string[]): void {
  if (patterns.length === 0) return;
  const beforeSpans = new Map<string, Array<{ start: number; end: number }>>();
  const afterSpans = new Map<string, Array<{ start: number; end: number }>>();
  collectRedactedSpans(report.structure.before, patterns, beforeSpans);
  collectRedactedSpans(report.structure.after, patterns, afterSpans);
  redactStructureValues(report.structure.before, patterns);
  redactStructureValues(report.structure.after, patterns);
  for (const file of report.files) {
    if (file.pathBefore) {
      file.beforeSource = redactSource(
        file.beforeSource,
        beforeSpans.get(file.pathBefore),
      );
    }
    if (file.pathAfter) {
      file.afterSource = redactSource(
        file.afterSource,
        afterSpans.get(file.pathAfter),
      );
    }
    // Expanded spans are not guaranteed to retain raw-source offsets.
    file.beforeExpandedSource = undefined;
    file.afterExpandedSource = undefined;
  }
}

function graphEdges(
  project: SourceProject,
  side: 'left' | 'right',
): DiffReport['dependencyGraph']['edges'] {
  try {
    const files = normalizeProject(project).files;
    const references =
      project.referencedModules ?? scanReferencedModules(files);
    return Object.entries(references).flatMap(([from, specifiers]) =>
      specifiers.flatMap(specifier => {
        const to = project.resolutions?.[from]?.[specifier];
        return to ? [{ from, to, specifier, side }] : [];
      }),
    );
  } catch {
    return [];
  }
}

function mergeGraph(
  report: DiffReport,
  left: SourceProject,
  right: SourceProject,
): void {
  const edges = [...graphEdges(left, 'left'), ...graphEdges(right, 'right')];
  const merged = new Map<string, (typeof edges)[number]>();
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.specifier}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, side: 'both' } : edge);
  }
  report.dependencyGraph.edges = [...merged.values()];
  const leftFiles = normalizeProject(left).files;
  const rightFiles = normalizeProject(right).files;
  const files = new Set([
    ...Object.keys(leftFiles),
    ...Object.keys(rightFiles),
  ]);
  report.dependencyGraph.nodes = [...files].map(file => ({
    id: `file-${digest(file)}`,
    path: file,
    before: file in leftFiles,
    after: file in rightFiles,
  }));
}

function sourceLocation(filename: string, code: string) {
  const lines = code.split(/\r?\n/);
  return {
    file: filename,
    start: 0,
    end: code.length,
    line: 1,
    column: 1,
    endLine: lines.length,
    endColumn: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

function fallbackReport(
  left: ReturnType<typeof normalizeProject>,
  right: ReturnType<typeof normalizeProject>,
  leftEvaluation: EvaluationResult,
  rightEvaluation: EvaluationResult,
  options: DiffOptions,
  error: unknown,
  redactAll: boolean,
): DiffReport {
  const beforeSpan = sourceLocation(left.filename, left.code);
  const afterSpan = sourceLocation(right.filename, right.code);
  const evaluationStatus =
    leftEvaluation.value !== undefined && rightEvaluation.value !== undefined
      ? 'complete'
      : leftEvaluation.value !== undefined ||
          rightEvaluation.value !== undefined
        ? 'partial'
        : 'unavailable';
  const redactFallback = redactAll || Boolean(options.redact?.length);
  const safeSource = options.includeSource !== false && !redactFallback;
  const safeError = redactFallback
    ? 'Evaluation or parsing failed while sensitive paths were protected.'
    : error instanceof Error
      ? error.message
      : String(error);
  const files = new Set([
    ...Object.keys(left.files),
    ...Object.keys(right.files),
  ]);
  const report: DiffReport = {
    schemaVersion: 1,
    comparison: {
      left: { label: left.filename, filename: left.filename },
      right: { label: right.filename, filename: right.filename },
      optionsDigest: digest({
        arrayKeys: options.arrayKeys,
        ignore: options.ignore,
        redact: options.redact,
        maxMatchWork: options.maxMatchWork,
      }),
    },
    summary: {
      total: 1,
      semantic: 0,
      sourceOnly: 0,
      unknown: 1,
      added: 0,
      removed: 0,
      modified: 1,
      moved: 0,
      renamed: 0,
      ignored: 0,
      evaluationStatus,
    },
    changes: [
      {
        id: `change-${digest({
          kind: 'modify',
          path: '',
          left: left.code,
          right: right.code,
        })}`,
        classification: 'unknown',
        kind: 'modify',
        pathBefore: '',
        pathAfter: '',
        before:
          leftEvaluation.value === undefined
            ? undefined
            : {
                valueType: typeof leftEvaluation.value,
                preview: redactFallback ? '••••••' : leftEvaluation.value,
                redacted: redactFallback,
              },
        after:
          rightEvaluation.value === undefined
            ? undefined
            : {
                valueType: typeof rightEvaluation.value,
                preview: redactFallback ? '••••••' : rightEvaluation.value,
                redacted: redactFallback,
              },
        spans: { before: beforeSpan, after: afterSpan },
        originChain: [beforeSpan, afterSpan],
        relatedChangeIds: [],
        ignored: false,
        sensitive: redactFallback,
        matchReason: 'parse-recovery',
      },
    ],
    structure: {},
    files: [
      {
        pathBefore: left.filename,
        pathAfter: right.filename,
        beforeSource: safeSource ? left.code : undefined,
        afterSource: safeSource ? right.code : undefined,
      },
    ],
    dependencyGraph: {
      nodes: [...files].map(file => ({
        id: `file-${digest(file)}`,
        path: file,
        before: file in left.files,
        after: file in right.files,
      })),
      edges: [],
    },
    evaluation: {
      status: evaluationStatus,
      before:
        leftEvaluation.value === undefined
          ? undefined
          : redactFallback
            ? '••••••'
            : leftEvaluation.value,
      after:
        rightEvaluation.value === undefined
          ? undefined
          : redactFallback
            ? '••••••'
            : rightEvaluation.value,
      leftError:
        leftEvaluation.error && !redactFallback
          ? leftEvaluation.error
          : undefined,
      rightError:
        rightEvaluation.error && !redactFallback
          ? rightEvaluation.error
          : undefined,
      sensitive: redactFallback,
    },
    diagnostics: [
      {
        side: 'both',
        severity: 'error',
        code: 'parse-recovery',
        message: safeError,
      },
    ],
  };
  applyIgnore(report, options.ignore ?? []);
  mergeGraph(report, left, right);
  return report;
}

export function diffProjects(
  leftSource: SourceProject,
  rightSource: SourceProject,
  options: DiffOptions = {},
): DiffReport {
  const left = normalizeProject(leftSource);
  const right = normalizeProject(rightSource);
  const leftEvaluation = evaluateProject(left, options);
  const rightEvaluation = evaluateProject(right, options);
  const revealSensitive =
    (options as DiffOptions & Record<symbol, unknown>)[TERMINAL_REVEAL] ===
    true;
  const redactAll =
    !revealSensitive && (leftEvaluation.sensitive || rightEvaluation.sensitive);
  let report: DiffReport;
  try {
    report = nativeDiffProjects(
      {
        filename: left.filename,
        code: left.code,
        files: left.files,
        evaluated: leftEvaluation.value,
        dependencies: leftEvaluation.dependencies,
        evaluationError:
          leftEvaluation.sensitive && !revealSensitive
            ? leftEvaluation.error
              ? 'Evaluation failed for an env-derived configuration.'
              : undefined
            : leftEvaluation.error,
      },
      {
        filename: right.filename,
        code: right.code,
        files: right.files,
        evaluated: rightEvaluation.value,
        dependencies: rightEvaluation.dependencies,
        evaluationError:
          rightEvaluation.sensitive && !revealSensitive
            ? rightEvaluation.error
              ? 'Evaluation failed for an env-derived configuration.'
              : undefined
            : rightEvaluation.error,
      },
      {
        arrayKeys: options.arrayKeys,
        redact: options.redact,
        redactAll,
        includeSource: options.includeSource,
        maxMatchWork: options.maxMatchWork,
      },
    ) as DiffReport;
  } catch (error) {
    return fallbackReport(
      left,
      right,
      leftEvaluation,
      rightEvaluation,
      options,
      error,
      redactAll,
    );
  }
  if (
    (leftEvaluation.value === undefined) !==
    (rightEvaluation.value === undefined)
  ) {
    report.evaluation.status = 'partial';
    report.summary.evaluationStatus = 'partial';
  }

  if (!redactAll && options.redact?.length) {
    report.evaluation.before = redactEvaluation(
      report.evaluation.before,
      options.redact,
    );
    report.evaluation.after = redactEvaluation(
      report.evaluation.after,
      options.redact,
    );
  }
  const reportFile = report.files[0];
  if (reportFile && options.includeSource !== false) {
    reportFile.beforeExpandedSource =
      (leftEvaluation.sensitive && !revealSensitive) ||
      Boolean(options.redact?.length)
        ? undefined
        : leftEvaluation.expandedSource;
    reportFile.afterExpandedSource =
      (rightEvaluation.sensitive && !revealSensitive) ||
      Boolean(options.redact?.length)
        ? undefined
        : rightEvaluation.expandedSource;
  }
  classifySourceOnly(report);
  redactReportSources(report, options.redact ?? []);
  applyIgnore(report, options.ignore ?? []);
  mergeGraph(report, left, right);
  return report;
}

export async function diff(
  leftSource: DiffSource,
  rightSource: DiffSource,
  options: DiffOptions = {},
): Promise<DiffReport> {
  const [left, right] = await Promise.all([
    resolveDiffSource(leftSource),
    resolveDiffSource(rightSource),
  ]);
  const report = diffProjects(left.project, right.project, options);
  report.comparison.left = {
    label: left.label,
    filename: left.project.filename,
    ref: left.ref,
  };
  report.comparison.right = {
    label: right.label,
    filename: right.project.filename,
    ref: right.ref,
  };
  return report;
}

export function policyFails(
  report: DiffReport,
  defaultPolicy: 'none' | 'semantic' | 'any',
  policies: DiffOptions['policies'] = [],
): boolean {
  return report.changes.some((change: DiffChange) => {
    if (change.ignored) return false;
    const path = change.pathAfter ?? change.pathBefore ?? '';
    const policy =
      policies
        ?.filter(candidate => pointerMatches(candidate.match, path))
        .at(-1)?.failOn ?? defaultPolicy;
    if (policy === 'none') return false;
    if (policy === 'semantic') return change.classification === 'semantic';
    return true;
  });
}

void renderHtml;
