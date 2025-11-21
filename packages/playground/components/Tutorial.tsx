'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Circle, ChevronRight, ArrowRight } from 'lucide-react';
import { TutorialStep } from '../lib/tutorial-steps';
import clsx from 'clsx';

interface TutorialProps {
  steps: TutorialStep[];
  currentStepIndex: number;
  onNext: () => void;
  isStepComplete: boolean;
}

export function Tutorial({ steps, currentStepIndex, onNext, isStepComplete }: TutorialProps) {
  const currentStep = steps[currentStepIndex];

  return (
    <div className="flex flex-col h-full text-neutral-300">
      {/* Header */}
      <div className="p-8 pb-4">
        <h2 className="text-lg font-medium text-white tracking-tight">
          Interactive Tour
        </h2>
        <p className="text-sm text-neutral-500 mt-1 font-mono">
          {currentStepIndex + 1} / {steps.length}
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-4 space-y-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <h3 className="text-2xl font-medium text-white mb-4 tracking-tight">{currentStep.title}</h3>
            <p className="text-neutral-400 leading-relaxed mb-8 font-light">
              {currentStep.description}
            </p>

            <div className="relative pl-4 border-l border-neutral-800">
              <div className="absolute -left-[5px] top-0 w-2.5 h-2.5 rounded-full bg-neutral-800 ring-4 ring-[#050505]" />
              <h4 className="text-xs font-medium text-neutral-500 uppercase tracking-widest mb-2">
                Goal
              </h4>
              <p className="text-neutral-200 font-medium">
                {currentStep.goal}
              </p>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="p-8 pt-4">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {isStepComplete ? (
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="flex items-center gap-2 text-white"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
                <span className="text-sm font-medium tracking-wide">Completed</span>
              </motion.div>
            ) : (
              <div className="flex items-center gap-2 text-neutral-600">
                <div className="w-1.5 h-1.5 rounded-full bg-neutral-700" />
                <span className="text-sm font-medium tracking-wide">In Progress</span>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={onNext}
          disabled={!isStepComplete}
          className={clsx(
            'group w-full flex items-center justify-between py-4 px-6 rounded-none border border-neutral-800 transition-all duration-300',
            isStepComplete
              ? 'bg-white text-black hover:bg-neutral-200 border-transparent'
              : 'bg-transparent text-neutral-600 cursor-not-allowed'
          )}
        >
          <span className="font-medium tracking-wide">
            {currentStepIndex === steps.length - 1 ? 'Finish Tour' : 'Next Step'}
          </span>
          <ArrowRight className={clsx(
            "w-4 h-4 transition-transform duration-300",
            isStepComplete && "group-hover:translate-x-1"
          )} />
        </button>
      </div>
    </div>
  );
}
