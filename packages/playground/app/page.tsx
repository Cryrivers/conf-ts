'use client';

import clsx from 'clsx';
import { Github, RotateCcw } from 'lucide-react';
import { createParser, useQueryState } from 'nuqs';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { CompletionModal } from '../components/CompletionModal';
import { Editor } from '../components/Editor';
import { Preview } from '../components/Preview';
import { Tutorial } from '../components/Tutorial';
import { tutorialSteps } from '../lib/tutorial-steps';

type CompileResult = { output: string; dependencies: string[] };

// Custom parser that clamps step index to valid range
const parseAsStepIndex = createParser({
  parse: (value: string) => {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.min(parsed, tutorialSteps.length - 1));
  },
  serialize: (value: number) => String(value),
}).withDefault(0);

function PageContent() {
  const [currentStepIndex, setCurrentStepIndex] = useQueryState(
    'step',
    parseAsStepIndex,
  );
  const [input, setInput] = useState(
    () => tutorialSteps[currentStepIndex].initialCode,
  );
  const [format, setFormat] = useState<'json' | 'yaml'>('json');
  const [macro, setMacro] = useState(true);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStepComplete, setIsStepComplete] = useState(false);
  const [showCompletion, setShowCompletion] = useState(false);

  const debounceTimer = useRef<number | null>(null);
  const prevStepIndexRef = useRef(currentStepIndex);

  // Sync editor content when step changes from URL navigation (browser back/forward)
  useEffect(() => {
    if (prevStepIndexRef.current !== currentStepIndex) {
      setInput(tutorialSteps[currentStepIndex].initialCode);
      setIsStepComplete(false);
      prevStepIndexRef.current = currentStepIndex;
    }
  }, [currentStepIndex]);

  const currentStep = tutorialSteps[currentStepIndex];

  const files = useMemo(() => {
    return {
      '/index.conf.ts': input,
      '/tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          jsx: 'react-jsx',
        },
      }),
    } as Record<string, string>;
  }, [input]);

  const compile = useCallback(async () => {
    setError(null);
    try {
      const { compileInMemory } = await import('@conf-ts/compiler/browser');
      const compiled = compileInMemory(
        files,
        '/index.conf.ts',
        format,
        macro,
        undefined,
        { env: { NODE_ENV: 'production' } },
      );

      let parsedOutput = null;
      try {
        if (format === 'json') {
          parsedOutput = JSON.parse(compiled.output);
        } else {
          // Always compile to JSON for validation if we're not in JSON mode
          const jsonCompiled = compileInMemory(
            files,
            '/index.conf.ts',
            'json',
            macro,
            undefined,
            { env: { NODE_ENV: 'production' } },
          );
          parsedOutput = JSON.parse(jsonCompiled.output);
        }
      } catch (e) {
        // ignore
      }

      setResult(compiled);

      if (currentStep.check(parsedOutput, input)) {
        setIsStepComplete(true);
      } else {
        setIsStepComplete(false);
      }
    } catch (e: any) {
      setResult(null);
      setError(e?.toString?.() ?? String(e));
      setIsStepComplete(false);
    }
  }, [files, format, macro, currentStep, input]);

  useEffect(() => {
    void compile();
  }, []);

  useEffect(() => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = window.setTimeout(() => {
      void compile();
    }, 500);
    return () => {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
      }
    };
  }, [input, format, macro, compile]);

  const handleNextStep = () => {
    if (currentStepIndex < tutorialSteps.length - 1) {
      const nextIndex = currentStepIndex + 1;
      setCurrentStepIndex(nextIndex);
      setInput(tutorialSteps[nextIndex].initialCode);
      setIsStepComplete(false);
    } else {
      setShowCompletion(true);
    }
  };

  const handleResetStep = () => {
    setInput(currentStep.initialCode);
    setIsStepComplete(false);
  };

  const handleRestartTour = () => {
    setShowCompletion(false);
    setCurrentStepIndex(0);
    setInput(tutorialSteps[0].initialCode);
    setIsStepComplete(false);
  };

  return (
    <>
      <main className="flex h-screen w-full overflow-hidden bg-[#050505] text-neutral-200 font-sans selection:bg-white/10">
        {/* Left Panel: Tutorial Guide */}
        <div className="w-[400px] h-full border-r border-white/5 bg-[#050505] flex flex-col z-20">
          <div className="flex-1 min-h-0 relative">
            <Tutorial
              steps={tutorialSteps}
              currentStepIndex={currentStepIndex}
              onNext={handleNextStep}
              isStepComplete={isStepComplete}
            />
          </div>

          <div className="px-8 py-6 border-t border-white/5 bg-[#050505] shrink-0 z-20">
            <a
              href="https://github.com/Cryrivers/conf-ts"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white hover:text-white transition-colors flex items-center gap-2 mb-2 font-medium tracking-tight"
            >
              <Github className="w-4 h-4" />
              <span>conf-ts</span>
            </a>

            <p className="text-xs text-neutral-500 leading-relaxed">
              Type-safe configuration for modern applications.
            </p>
            <div className="flex items-center mt-4 gap-4">
              <p className="text-xs text-neutral-700">
                MIT License © 2025 Wang Zhongliang
              </p>
            </div>
          </div>
        </div>

        {/* Right Panel: Editor & Preview */}
        <div className="flex-1 flex flex-col h-full min-w-0 bg-[#050505] relative">
          {/* Toolbar */}
          <header className="h-14 border-b border-white/5 flex items-center justify-between px-6 shrink-0 z-20 bg-[#050505]/80 backdrop-blur-sm">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-1">
                {['json', 'yaml'].map(f => (
                  <button
                    key={f}
                    onClick={() => setFormat(f as 'json' | 'yaml')}
                    className={clsx(
                      'px-3 py-1.5 text-xs font-medium rounded transition-all duration-200',
                      format === f
                        ? 'text-white bg-white/10'
                        : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5',
                    )}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="h-4 w-px bg-white/5" />

              <button
                onClick={() => setMacro(!macro)}
                className={clsx(
                  'flex items-center gap-2 text-xs font-medium transition-colors duration-200',
                  macro
                    ? 'text-blue-400'
                    : 'text-neutral-500 hover:text-neutral-300',
                )}
              >
                <div
                  className={clsx(
                    'w-2 h-2 rounded-full transition-colors duration-200',
                    macro
                      ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]'
                      : 'bg-neutral-700',
                  )}
                />
                Macros
              </button>
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={handleResetStep}
                className="flex items-center gap-2 text-xs font-medium text-neutral-500 hover:text-white transition-colors"
                title="Reset to initial code"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>
          </header>

          {/* Main Content Area */}
          <div className="flex-1 flex min-h-0 relative">
            {/* Editor */}
            <div className="flex-1 relative border-r border-white/5">
              <Editor value={input} onChange={val => setInput(val ?? '')} />
            </div>

            {/* Preview */}
            <div className="flex-1 relative bg-[#050505]">
              <Preview
                output={result?.output ?? null}
                error={error}
                format={format}
              />
            </div>
          </div>
        </div>
      </main>

      <CompletionModal
        isOpen={showCompletion}
        onClose={() => setShowCompletion(false)}
        onRestart={handleRestartTour}
      />
    </>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-full items-center justify-center bg-[#050505] text-neutral-500">
          Loading...
        </div>
      }
    >
      <PageContent />
    </Suspense>
  );
}
