'use client';

import type { Monaco } from '@monaco-editor/react';
import { shikiToMonaco, textmateThemeToMonacoTheme } from '@shikijs/monaco';
import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { createHighlighter } from 'shiki';
import type { LanguageRegistration } from 'shiki';
import tsxLang from 'shiki/langs/tsx.mjs';

const MonacoEditor = dynamic(async () => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-neutral-800">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  ),
});

const SHIKI_THEME = 'github-dark';
const SHIKI_MONACO_SETUP_PROPERTY = '__confTsShikiMonacoSetup';
const MONACO_CANCEL_HANDLER_PROPERTY = '__confTsMonacoCancelHandlerInstalled';

type MonacoThemeData = Parameters<Monaco['editor']['defineTheme']>[1];
type MonacoWithShikiSetup = Monaco & {
  [SHIKI_MONACO_SETUP_PROPERTY]?: Promise<void>;
};

const typescriptWithTsxSyntax = tsxLang.map(
  (lang): LanguageRegistration => ({
    ...lang,
    name: 'typescript',
    aliases: ['ts', 'tsx'],
  }),
);

function isMonacoCancellation(value: unknown) {
  const error = value as {
    message?: unknown;
    name?: unknown;
    stack?: unknown;
    type?: unknown;
  };

  if (error?.type === 'cancelation') {
    return true;
  }

  const stack = typeof error?.stack === 'string' ? error.stack : '';
  return (
    error?.name === 'Canceled' &&
    error?.message === 'Canceled' &&
    (stack.includes('monaco-editor') ||
      stack.includes('/vs/editor') ||
      stack.includes('editor.api-'))
  );
}

function installMonacoCancellationHandler() {
  if (typeof window === 'undefined') {
    return;
  }

  const browserWindow = window as Window & {
    [MONACO_CANCEL_HANDLER_PROPERTY]?: true;
  };

  if (browserWindow[MONACO_CANCEL_HANDLER_PROPERTY]) {
    return;
  }

  browserWindow[MONACO_CANCEL_HANDLER_PROPERTY] = true;

  window.addEventListener('unhandledrejection', event => {
    if (isMonacoCancellation(event.reason)) {
      event.preventDefault();
    }
  });

  window.addEventListener('error', event => {
    if (isMonacoCancellation(event.error)) {
      event.preventDefault();
    }
  });
}

function setupShikiMonaco(monaco: Monaco) {
  const monacoWithSetup = monaco as MonacoWithShikiSetup;

  installMonacoCancellationHandler();

  monacoWithSetup[SHIKI_MONACO_SETUP_PROPERTY] ??= createHighlighter({
    themes: [SHIKI_THEME],
    langs: typescriptWithTsxSyntax,
  })
    .then(highlighter => {
      shikiToMonaco(highlighter, monaco);

      const theme = textmateThemeToMonacoTheme(
        highlighter.getTheme(SHIKI_THEME),
      ) as MonacoThemeData;
      monaco.editor.defineTheme(SHIKI_THEME, {
        ...theme,
        colors: {
          ...theme.colors,
          'editor.background': '#050505',
          'editor.lineHighlightBackground': '#ffffff05',
          'editorLineNumber.foreground': '#333333',
          'editorLineNumber.activeForeground': '#666666',
        },
      });
      monaco.editor.setTheme(SHIKI_THEME);
    })
    .catch(error => {
      monacoWithSetup[SHIKI_MONACO_SETUP_PROPERTY] = undefined;
      console.error('Shiki Monaco setup failed:', error);
    });

  return monacoWithSetup[SHIKI_MONACO_SETUP_PROPERTY];
}

interface EditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  readOnly?: boolean;
  path?: string;
}

export function Editor({
  value,
  onChange,
  readOnly = false,
  path = '/index.conf.ts',
}: EditorProps) {
  const language = 'typescript';

  return (
    <div className="h-full w-full relative group">
      {/* Subtle gradient overlay at the top */}
      <div className="absolute top-0 left-0 right-0 h-12 bg-linear-to-b from-[#050505] to-transparent z-10 pointer-events-none" />

      <MonacoEditor
        height="100%"
        defaultLanguage={language}
        language={language}
        path={path}
        theme="vs-dark"
        value={value}
        onChange={onChange}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontLigatures: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          readOnly,
          padding: { top: 32, bottom: 32 },
          lineNumbers: 'on',
          renderLineHighlight: 'none', // Minimalist
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          guides: { indentation: false }, // Cleaner look
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            vertical: 'hidden', // Hide scrollbar by default, show on hover if needed (or keep hidden for ultra-clean)
            horizontal: 'hidden',
            useShadows: false,
          },
        }}
        onMount={(editor, monaco) => {
          // Custom theme to match the deep black aesthetic
          monaco.editor.defineTheme('vs-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
              'editor.background': '#050505', // Match global background
              'editor.lineHighlightBackground': '#ffffff05',
              'editorLineNumber.foreground': '#333333',
              'editorLineNumber.activeForeground': '#666666',
            },
          });
          monaco.editor.setTheme('vs-dark');

          void setupShikiMonaco(monaco);

          // Configure compiler options
          monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ESNext,
            allowNonTsExtensions: true,
            moduleResolution:
              monaco.languages.typescript.ModuleResolutionKind.NodeJs,
            module: monaco.languages.typescript.ModuleKind.CommonJS,
            noEmit: true,
            esModuleInterop: true,
            jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
            jsxImportSource: '@conf-ts/macro',
          });

          // Add @conf-ts/macro types
          monaco.languages.typescript.typescriptDefaults.addExtraLib(
            `
            declare module '@conf-ts/macro' {
              export function String(value: any): string;
              export function Number(value: any): number;
              export function Boolean(value: any): boolean;
              export function arrayMap<T, U>(array: T[], callback: (item: T) => U): U[];
              export function arrayFlatMap<T, U>(
                array: T[],
                callback: (item: T) => U | U[],
              ): U[];
              export function arrayFilter<T>(
                array: T[],
                predicate: (item: T) => boolean,
              ): T[];
              export function env(key: string): string | undefined;
            }
            `,
            'file:///node_modules/@conf-ts/macro/index.d.ts',
          );

          // Add @conf-ts/macro/jsx-runtime types
          monaco.languages.typescript.typescriptDefaults.addExtraLib(
            `
            declare module '@conf-ts/macro/jsx-runtime' {
              export interface JsxOutputOptions {
                type?: string;
                props?: string | false;
                children?: string | false;
                key?: string;
                fragment?: string;
              }
              export const Fragment: string;
              export function jsx(
                type: string,
                props: Record<string, any> | null | undefined,
                key?: string,
              ): Record<string, any>;
              export const jsxs: typeof jsx;
              export namespace JSX {
                type Element = Record<string, any>;
                interface IntrinsicElements { [elemName: string]: Record<string, any>; }
                interface ElementChildrenAttribute { children: {}; }
              }
            }
            declare var __CONF_TS_JSX_OUTPUT__: import('@conf-ts/macro/jsx-runtime').JsxOutputOptions | undefined;
            `,
            'file:///node_modules/@conf-ts/macro/jsx-runtime.d.ts',
          );
        }}
      />
    </div>
  );
}
