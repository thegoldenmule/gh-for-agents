// What a tool result says that depends on the machine or the clock, replaced before anything is measured, so
// the same fixtures give the same report bytes on every run and every machine. Each rule keeps the replaced
// text's length where it can, so byte counts stay representative.

/** Where the oracle's per-answer directories appear in reports. */
export const SCRUB_ROOT = '/tmp/ghx-oracle';

export interface ScrubRule {
  id: string;
  pattern: RegExp;
  replace: string;
}

export const SCRUB_RULES: readonly ScrubRule[] = [
  // ci wait's events file: ci-wait-<epoch ms>-<random hex>.ndjson
  { id: 'ci-wait-events-name', pattern: /ci-wait-\d{13}-[0-9a-f]{8}/g, replace: 'ci-wait-0000000000000-00000000' },
  // Seconds a ci wait ran: wall clock.
  { id: 'elapsed-sec', pattern: /"elapsedSec":\d+/g, replace: '"elapsedSec":0' },
];

/** Replace the run's temporary root with SCRUB_ROOT, then apply SCRUB_RULES in order. */
export function scrub(text: string, root: string): string {
  let out = root === '' ? text : text.split(root).join(SCRUB_ROOT);
  for (const r of SCRUB_RULES) {
    out = out.replace(r.pattern, r.replace);
  }
  return out;
}
