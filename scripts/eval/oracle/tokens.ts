// Result tokens for one tool call (plan 07, metric catalog: `chars / 2.2 + 70`). The only place the oracle
// defines it; scripts/eval/metrics/catalog.ts takes it over once it exists.

/** Characters per token for tool-result text. */
export const RESULT_CHARS_PER_TOKEN = 2.2;
/** Per-call overhead in tokens (the tool_use and tool_result framing). */
export const RESULT_TOKEN_OVERHEAD = 70;

/** Characters as the Python prototypes count them: code points, not UTF-16 units. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Estimated tokens for one tool call whose result is `chars` long, rounded to the nearest integer. */
export function estimateResultTokens(chars: number): number {
  return Math.round(chars / RESULT_CHARS_PER_TOKEN + RESULT_TOKEN_OVERHEAD);
}
