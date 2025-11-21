'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { 
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-neutral-800">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  )
});

interface EditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  readOnly?: boolean;
}

export function Editor({ value, onChange, readOnly = false }: EditorProps) {
  return (
    <div className="h-full w-full relative group">
      {/* Subtle gradient overlay at the top */}
      <div className="absolute top-0 left-0 right-0 h-12 bg-gradient-to-b from-[#050505] to-transparent z-10 pointer-events-none" />
      
      <MonacoEditor
        height="100%"
        defaultLanguage="typescript"
        path="/index.conf.ts"
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
            }
          });
          monaco.editor.setTheme('vs-dark');
        }}
      />
    </div>
  );
}
