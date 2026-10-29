// Result tokens for one tool call (plan 07, metric catalog: `chars / 2.2 + 70`). The constants are the
// catalog's (scripts/eval/metrics/catalog.ts), so the oracle and the observe tier share one metric core.
import { CONSTANTS } from '../metrics/catalog.ts';
import { codePointLength } from '../model/usage.ts';

/** Characters per token for tool-result text. */
export const RESULT_CHARS_PER_TOKEN = CONSTANTS.CHARS_PER_TOKEN;
/** Per-call overhead in tokens (the tool_use and tool_result framing). */
export const RESULT_TOKEN_OVERHEAD = CONSTANTS.RESULT_OVERHEAD;

/** Characters as the Python prototypes count them: code points, not UTF-16 units. */
export const charCount = codePointLength;

/** Estimated tokens for one tool call whose result is `chars` long, rounded to the nearest integer. */
export function estimateResultTokens(chars: number): number {
  return Math.round(chars / RESULT_CHARS_PER_TOKEN + RESULT_TOKEN_OVERHEAD);
}
