// Control-flow throws (01 §3.5, §3.6): DryRunHalt, INTERRUPTED, TIMEOUT and AbortError are thrown
// through handler code so the runner can turn them into the dry-run result, the interrupted summary
// or the timeout error. A handler's catch-all must not swallow them:
//
//   try { … } catch (e) { rethrowControlFlow(e); /* handle ordinary failures */ }
import { DryRunHalt } from '../gh/index.ts';
import { isAbort } from './signals.ts';

/** True for throws that belong to the runner, never to a handler's catch-all. */
export function isControlFlow(e: unknown): boolean {
  return e instanceof DryRunHalt || isAbort(e);
}

/** Rethrow `e` if it is control flow; otherwise return so the caller can handle it. */
export function rethrowControlFlow(e: unknown): void {
  if (isControlFlow(e)) throw e;
}
