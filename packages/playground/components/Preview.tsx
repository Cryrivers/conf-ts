'use client';

import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';

interface PreviewProps {
  output: string | null;
  error: string | null;
  format: 'json' | 'yaml';
}

export function Preview({ output, error, format }: PreviewProps) {
  const [highlighted, setHighlighted] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function highlight() {
      if (output) {
        try {
          const html = await codeToHtml(output, {
            lang: format,
            theme: 'github-dark',
          });
          if (mounted) {
            setHighlighted(html);
          }
        } catch (e) {
          console.error('Shiki highlighting failed:', e);
          if (mounted) {
            setHighlighted(output); // Fallback to plain text
          }
        }
      } else {
        if (mounted) {
          setHighlighted('');
        }
      }
    }

    highlight();

    return () => {
      mounted = false;
    };
  }, [output, format]);

  const handleCopy = async () => {
    if (output) {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="h-full flex flex-col text-neutral-300 relative">
      {/* Subtle gradient overlay at the top */}
      <div className="absolute top-0 left-0 right-0 h-12 bg-linear-to-b from-[#050505] to-transparent z-10 pointer-events-none" />

      <div className="flex items-center justify-between px-8 py-4 shrink-0 z-20">
        <span className="text-[10px] font-medium text-neutral-600 uppercase tracking-[0.2em]">
          Output / {format}
        </span>
        {output && !error && (
          <button
            onClick={handleCopy}
            className="text-neutral-600 hover:text-white transition-colors"
            title="Copy to clipboard"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8 pt-2 relative scrollbar-hide">
        {error ? (
          <div className="text-red-400/80 font-mono text-sm whitespace-pre-wrap">
            {error}
          </div>
        ) : output ? (
          <pre
            className={clsx(
              'font-mono text-sm bg-transparent! m-0! p-0! text-neutral-400!',
              `language-${format}`,
            )}
          >
            <code
              dangerouslySetInnerHTML={{ __html: highlighted }}
              className="[&>pre]:bg-transparent!"
            />
          </pre>
        ) : (
          <div className="flex items-center justify-center h-full">
            <span className="text-neutral-800 text-sm font-medium tracking-widest uppercase">
              Waiting for input
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
