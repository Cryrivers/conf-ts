import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createMacroProjectSnapshot } from '@conf-ts/macro-transformer-native';

import type { DiffSource, SourceProject } from './types.js';

const execFile = promisify(execFileCallback);
const SOURCE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.mts',
  '/index.js',
];

export interface ResolvedSource {
  project: SourceProject;
  label: string;
  ref?: string;
}

interface GitTsConfig {
  directory: string;
  compilerOptions: Record<string, unknown> & {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function sourceProject(
  filename: string,
  code: string,
  project?: Omit<SourceProject, 'filename' | 'code'>,
): SourceProject {
  return {
    filename,
    code,
    ...project,
    files: {
      ...(project?.files ?? {}),
      [filename]: code,
    },
  };
}

async function git(
  repo: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFile('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function repositoryRoot(repo: string): Promise<string> {
  const { stdout } = await git(repo, ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

async function readGitText(
  repo: string,
  ref: string,
  relativePath: string,
): Promise<string | undefined> {
  const normalized = relativePath.replaceAll(path.sep, '/');
  try {
    if (ref === 'worktree') {
      return await fs.promises.readFile(path.join(repo, normalized), 'utf8');
    }
    const object = ref === 'index' ? `:${normalized}` : `${ref}:${normalized}`;
    const { stdout } = await git(repo, ['show', object]);
    return stdout;
  } catch {
    return undefined;
  }
}

function staticSpecifiers(code: string): string[] {
  const values = new Set<string>();
  const pattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(pattern)) {
    const value = match[1] ?? match[2];
    if (value) values.add(value);
  }
  return [...values];
}

async function resolveGitSpecifier(
  repo: string,
  ref: string,
  containingPath: string,
  specifier: string,
  tsconfig?: GitTsConfig,
): Promise<{ relativePath: string; code: string } | undefined> {
  const bases: string[] = [];
  if (specifier.startsWith('.')) {
    bases.push(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(containingPath), specifier),
      ),
    );
  } else if (tsconfig?.compilerOptions.paths) {
    for (const [pattern, targets] of Object.entries(
      tsconfig.compilerOptions.paths,
    )) {
      const wildcard = pattern.indexOf('*');
      const matches =
        wildcard < 0
          ? pattern === specifier
            ? ''
            : undefined
          : specifier.startsWith(pattern.slice(0, wildcard)) &&
              specifier.endsWith(pattern.slice(wildcard + 1))
            ? specifier.slice(
                wildcard,
                specifier.length - (pattern.length - wildcard - 1),
              )
            : undefined;
      if (matches === undefined) continue;
      for (const target of targets) {
        const resolvedTarget = target.replace('*', matches);
        bases.push(
          path.posix.normalize(
            path.posix.join(
              tsconfig.directory,
              tsconfig.compilerOptions.baseUrl ?? '.',
              resolvedTarget,
            ),
          ),
        );
      }
    }
  }
  for (const base of bases) {
    for (const suffix of SOURCE_EXTENSIONS) {
      const relativePath = `${base}${suffix}`;
      const code = await readGitText(repo, ref, relativePath);
      if (code !== undefined) return { relativePath, code };
    }
  }
  return undefined;
}

function parseJsonConfig(text: string): Record<string, unknown> {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutComments) as Record<string, unknown>;
}

async function loadGitTsConfig(
  repo: string,
  ref: string,
  entryPath: string,
): Promise<GitTsConfig | undefined> {
  let directory = path.posix.dirname(entryPath);
  for (;;) {
    const candidate = path.posix.join(directory, 'tsconfig.json');
    const text = await readGitText(repo, ref, candidate);
    if (text !== undefined) {
      const parsed = parseJsonConfig(text);
      return {
        directory,
        compilerOptions:
          (parsed.compilerOptions as GitTsConfig['compilerOptions']) ?? {},
      };
    }
    if (!directory || directory === '.') return undefined;
    const parent = path.posix.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function loadGitSource(source: Extract<DiffSource, { kind: 'git' }>) {
  const root = await repositoryRoot(source.repo ?? process.cwd());
  const requested = path.isAbsolute(source.path)
    ? path.relative(root, source.path)
    : source.path;
  const entryRelative = requested.replaceAll(path.sep, '/');
  const entryCode = await readGitText(root, source.ref, entryRelative);
  if (entryCode === undefined) {
    throw new Error(
      `Could not read ${entryRelative} from Git source '${source.ref}'.`,
    );
  }

  const virtualRoot = `/${path.basename(root)}`;
  const virtualName = (relativePath: string) =>
    path.posix.join(virtualRoot, relativePath);
  const files: Record<string, string> = {
    [virtualName(entryRelative)]: entryCode,
  };
  const resolutions: Record<string, Record<string, string>> = {};
  const dependencies: string[] = [];
  const referencedModules: Record<string, string[]> = {};
  const tsconfig = await loadGitTsConfig(root, source.ref, entryRelative);
  const queue = [{ relativePath: entryRelative, code: entryCode }];
  const loaded = new Set([entryRelative]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const filename = virtualName(current.relativePath);
    dependencies.push(filename);
    const specifiers = staticSpecifiers(current.code);
    referencedModules[filename] = specifiers;
    for (const specifier of specifiers) {
      const resolved = await resolveGitSpecifier(
        root,
        source.ref,
        current.relativePath,
        specifier,
        tsconfig,
      );
      if (!resolved) continue;
      const resolvedName = virtualName(resolved.relativePath);
      (resolutions[filename] ??= {})[specifier] = resolvedName;
      files[resolvedName] = resolved.code;
      if (!loaded.has(resolved.relativePath)) {
        loaded.add(resolved.relativePath);
        queue.push(resolved);
      }
    }
  }

  return {
    project: sourceProject(virtualName(entryRelative), entryCode, {
      files,
      resolutions,
      compilerOptions: tsconfig?.compilerOptions,
      dependencies,
      referencedModules,
    }),
    label: source.label ?? `${source.ref}:${entryRelative}`,
    ref: source.ref,
  } satisfies ResolvedSource;
}

async function loadFileSource(source: Extract<DiffSource, { kind: 'file' }>) {
  const filename = path.resolve(source.path);
  const code = await fs.promises.readFile(filename, 'utf8');
  try {
    const snapshot = createMacroProjectSnapshot([filename], {
      overrides: { [filename]: code },
    });
    return {
      project: sourceProject(filename, code, {
        files: snapshot.files,
        resolutions: snapshot.resolutions,
        compilerOptions: snapshot.compilerOptions,
        dependencies: snapshot.dependencies,
        referencedModules: snapshot.referencedModules,
      }),
      label: source.label ?? source.path,
    } satisfies ResolvedSource;
  } catch {
    return {
      project: sourceProject(filename, code),
      label: source.label ?? source.path,
    } satisfies ResolvedSource;
  }
}

export async function resolveDiffSource(
  source: DiffSource,
): Promise<ResolvedSource> {
  if (source.kind === 'git') return loadGitSource(source);
  if (source.kind === 'file') return loadFileSource(source);
  return {
    project: sourceProject(source.filename, source.code, source.project),
    label: source.label ?? source.filename,
  };
}
