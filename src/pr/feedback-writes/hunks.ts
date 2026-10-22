// Diff hunks from a `pulls/N/files` patch (02 §7.2 inline placement). GitHub accepts a review comment only
// on a line the diff shows: on RIGHT, the `+c,d` range of a hunk (context and added lines); on LEFT, the
// `-a,b` range (context and removed lines). A multi-line comment must sit inside one hunk. A file without
// a patch (binary, or too large for GitHub to diff) has no commentable lines.

export type Side = 'RIGHT' | 'LEFT';
/** Inclusive line ranges per side. */
export interface Hunks {
  LEFT: [number, number][];
  RIGHT: [number, number][];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(patch: string | null | undefined): Hunks {
  const out: Hunks = { LEFT: [], RIGHT: [] };
  if (!patch) return out;
  for (const line of patch.split('\n')) {
    const m = HEADER.exec(line);
    if (!m) continue;
    const add = (side: Side, start: number, count: number) => {
      if (count > 0) out[side].push([start, start + count - 1]);
    };
    add('LEFT', Number(m[1]), m[2] === undefined ? 1 : Number(m[2]));
    add('RIGHT', Number(m[3]), m[4] === undefined ? 1 : Number(m[4]));
  }
  return out;
}

/** True when `line..endLine` on `side` lies inside a single hunk. */
export function inHunk(hunks: Hunks, side: Side, line: number, endLine: number = line): boolean {
  return hunks[side].some(([start, end]) => line >= start && endLine <= end);
}
