'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tutorial } from '../components/Tutorial';
import { Editor } from '../components/Editor';
import { Preview } from '../components/Preview';
import { tutorialSteps } from '../lib/tutorial-steps';
import { Play, RotateCcw, Settings2, Command } from 'lucide-react';
import clsx from 'clsx';

type CompileResult = { output: string; dependencies: string[] };

export default function Page() {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [input, setInput] = useState(tutorialSteps[0].initialCode);
  const [format, setFormat] = useState<'json' | 'yaml'>('json');
  const [macro, setMacro] = useState(true);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStepComplete, setIsStepComplete] = useState(false);
  
  const debounceTimer = useRef<number | null>(null);
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
        }
      }),
    } as Record<string, string>;
  }, [input]);

  const compile = useCallback(async () => {
    setError(null);
    try {
      const { compileInMemory } = await import('@conf-ts/compiler/browser');
      // @ts-ignore
      const compiled = compileInMemory(files, '/index.conf.ts', format, macro);
      
      let parsedOutput = null;
      try {
        if (format === 'json') {
          parsedOutput = JSON.parse(compiled.output);
        } else {
           if (currentStep.check.toString().includes('output')) {
             const jsonCompiled = compileInMemory(files, '/index.conf.ts', 'json', macro);
             parsedOutput = JSON.parse(jsonCompiled.output);
          }
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
      alert('Congratulations! You have completed the tour.');
    }
  };

  const handleResetStep = () => {
    setInput(currentStep.initialCode);
    setIsStepComplete(false);
  };

  return (
    <main className="flex h-screen w-full overflow-hidden bg-[#050505] text-neutral-200 font-sans selection:bg-white/10">
      {/* Left Panel: Tutorial Guide */}
      <div className="w-[400px] h-full border-r border-white/5 bg-[#050505] flex flex-col z-20">
        <div className="h-14 flex items-center px-8 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2 text-white font-medium tracking-tight">
            <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-white" />
            </div>
            conf-ts
          </div>
        </div>
        <Tutorial 
          steps={tutorialSteps}
          currentStepIndex={currentStepIndex}
          onNext={handleNextStep}
          isStepComplete={isStepComplete}
        />
      </div>

      {/* Right Panel: Editor & Preview */}
      <div className="flex-1 flex flex-col h-full min-w-0 bg-[#050505] relative">
        {/* Toolbar */}
        <header className="h-14 border-b border-white/5 flex items-center justify-between px-6 shrink-0 z-20 bg-[#050505]/80 backdrop-blur-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-1">
              {['json', 'yaml'].map((f) => (
                <button
                  key={f}
                  onClick={() => setFormat(f as 'json' | 'yaml')}
                  className={clsx(
                    "px-3 py-1.5 text-xs font-medium rounded transition-all duration-200",
                    format === f 
                      ? "text-white bg-white/10" 
                      : "text-neutral-500 hover:text-neutral-300 hover:bg-white/5"
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
                "flex items-center gap-2 text-xs font-medium transition-colors duration-200",
                macro ? "text-blue-400" : "text-neutral-500 hover:text-neutral-300"
              )}
            >
              <div className={clsx(
                "w-2 h-2 rounded-full transition-colors duration-200",
                macro ? "bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]" : "bg-neutral-700"
              )} />
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
            <Editor 
              value={input} 
              onChange={(val) => setInput(val ?? '')} 
            />
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
  );
}
