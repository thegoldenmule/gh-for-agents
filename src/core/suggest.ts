// "Did you mean" (§9.9): Damerau-Levenshtein distance (optimal string alignment variant).

export function editDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i <= n; i++) {
    const row = d[i] as number[];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, at(i - 2, j - 2) + 1);
      row[j] = v;
    }
  }
  return at(n, m);
}

export interface SuggestOptions {
  /** Maximum suggestions returned (default 3). */
  max?: number;
  /** Maximum distance accepted; default scales with the word length (1 for ≤4 chars, else ⌈len/3⌉). */
  maxDistance?: number;
}

/** Closest candidates to `word`, best first. Case-insensitive; exact matches are excluded. */
export function suggest(word: string, candidates: readonly string[], o: SuggestOptions = {}): string[] {
  const w = word.toLowerCase();
  const limit = o.maxDistance ?? (w.length <= 4 ? 1 : Math.ceil(w.length / 3));
  const scored: { c: string; d: number }[] = [];
  for (const c of new Set(candidates)) {
    const lc = c.toLowerCase();
    if (lc === w) continue;
    let dist = editDistance(w, lc);
    // A prefix of a longer candidate is a strong hint ("stat" → "status").
    if (lc.startsWith(w) && w.length >= 3) dist = Math.min(dist, 1);
    if (dist <= limit) scored.push({ c, d: dist });
  }
  scored.sort((x, y) => x.d - y.d || x.c.localeCompare(y.c));
  return scored.slice(0, o.max ?? 3).map((s) => s.c);
}
