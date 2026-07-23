'use client';

import type { DiffReport } from '@conf-ts/diff';
import { DiffExplorer } from '@conf-ts/diff/react';
import { ArrowLeftRight, BookOpen, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import {
  Editor,
  PLAYGROUND_MONACO_THEME,
} from '../../components/Editor';

const INITIAL_LEFT = `const shared = {
  region: 'ap-southeast-1',
  retries: 2,
};

export default {
  app: {
    name: 'checkout',
    enabled: true,
  },
  services: [
    { id: 'api', port: 8080, replicas: 2 },
    { id: 'worker', port: 8081, replicas: 1 },
  ],
  ...shared,
};`;

const INITIAL_RIGHT = `const shared = {
  region: 'ap-southeast-1',
  retries: 3,
};

export default {
  app: {
    name: 'checkout',
    enabled: false,
  },
  services: [
    { id: 'worker', port: 8081, replicas: 2 },
    { id: 'api', port: 8443, replicas: 3 },
    { id: 'metrics', port: 9090, replicas: 1 },
  ],
  ...shared,
};`;

export default function DiffPage() {
  const [left, setLeft] = useState(INITIAL_LEFT);
  const [right, setRight] = useState(INITIAL_RIGHT);
  const [report, setReport] = useState<DiffReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/diff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ left, right }),
          signal: controller.signal,
        });
        const value = await response.json();
        if (!response.ok) {
          throw new Error(value.error ?? 'Diff request failed');
        }
        setReport(value as DiffReport);
      } catch (requestError) {
        if (
          requestError instanceof DOMException &&
          requestError.name === 'AbortError'
        ) {
          return;
        }
        setError(
          requestError instanceof Error
            ? requestError.message
            : String(requestError),
        );
      } finally {
        if (requestRef.current === controller) setLoading(false);
      }
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [left, right]);

  const reset = () => {
    setLeft(INITIAL_LEFT);
    setRight(INITIAL_RIGHT);
  };

  return (
    <main className="min-h-screen bg-[#090b0f] text-neutral-100">
      <header className="h-14 border-b border-white/8 bg-[#0d1016] flex items-center justify-between px-5 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <ArrowLeftRight className="w-4 h-4 text-blue-400" />
          <div>
            <h1 className="text-sm font-semibold tracking-tight">
              conf.ts structural diff
            </h1>
            <p className="text-[10px] text-neutral-500">
              Oxc source structure + evaluated configuration
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500" aria-live="polite">
            {loading ? 'Analyzing…' : report ? 'Up to date' : ''}
          </span>
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" />
            Tutorial
          </Link>
        </div>
      </header>

      <section
        className="grid grid-cols-1 lg:grid-cols-2 border-b border-white/8"
        aria-label="Source editors"
      >
        <div className="h-[38vh] min-h-[280px] border-r border-white/8 flex flex-col">
          <div className="h-9 shrink-0 px-4 flex items-center border-b border-white/8 bg-[#10131a] text-[10px] uppercase tracking-[0.15em] text-neutral-500">
            Before
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              value={left}
              onChange={value => setLeft(value ?? '')}
              path="/before.conf.ts"
            />
          </div>
        </div>
        <div className="h-[38vh] min-h-[280px] flex flex-col">
          <div className="h-9 shrink-0 px-4 flex items-center border-b border-white/8 bg-[#10131a] text-[10px] uppercase tracking-[0.15em] text-neutral-500">
            After
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              value={right}
              onChange={value => setRight(value ?? '')}
              path="/after.conf.ts"
            />
          </div>
        </div>
      </section>

      <section className="p-3 md:p-5">
        {error ? (
          <div
            className="border border-red-500/30 bg-red-500/8 rounded-lg p-4 text-sm text-red-300 font-mono whitespace-pre-wrap"
            role="alert"
          >
            {error}
          </div>
        ) : report ? (
          <DiffExplorer
            report={report}
            monacoTheme={PLAYGROUND_MONACO_THEME}
          />
        ) : (
          <div className="h-80 flex items-center justify-center text-neutral-600">
            Preparing structural diff…
          </div>
        )}
      </section>
    </main>
  );
}
