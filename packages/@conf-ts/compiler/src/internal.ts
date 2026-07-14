/**
 * Low-level constant evaluator used by source front-ends.
 *
 * This subpath is intentionally separate from the compiler's public API: the
 * compiler itself only consumes ordinary TypeScript source.
 *
 * @internal
 */
export {
  createEvaluationState,
  createFileProgram,
  createSourceProgram,
} from './compiler';
export { createInMemoryProgram } from './browser';
export { evaluate } from './eval';
export type { EvaluationOptions, EvaluationState } from './internal-types';
