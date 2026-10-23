// A small line-based unified diff for `ghx install --dry-run`. The files it compares are short
// (settings.json, CLAUDE.md), so a plain LCS table is fast enough and keeps this dependency-free.

const CONTEXT = 3;

function lines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

type Op = { kind: ' ' | '-' | '+'; line: string; a: number; b: number };

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: ' ', line: a[i] as string, a: i++, b: j++ });
    } else if (i < n && (j >= m || (lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number))) {
      out.push({ kind: '-', line: a[i] as string, a: i++, b: j });
    } else {
      out.push({ kind: '+', line: b[j] as string, a: i, b: j++ });
    }
  }
  return out;
}

const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;

/** Unified diff of two file contents (null = absent), or '' when they are equal. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return '';
  const all = ops(lines(before), lines(after));
  const changed = all.map((o, k) => (o.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const out = [`--- ${before === null ? '/dev/null' : path}`, `+++ ${after === null ? '/dev/null' : path}`];
  let k = 0;
  while (k < changed.length) {
    const from = Math.max(0, (changed[k] as number) - CONTEXT);
    let to = Math.min(all.length, (changed[k] as number) + CONTEXT + 1);
    while (k + 1 < changed.length && (changed[k + 1] as number) - CONTEXT <= to) {
      k++;
      to = Math.min(all.length, (changed[k] as number) + CONTEXT + 1);
    }
    const hunk = all.slice(from, to);
    const first = hunk[0] as Op;
    const aCount = hunk.filter((o) => o.kind !== '+').length;
    const bCount = hunk.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${range(first.a + 1, aCount)} +${range(first.b + 1, bCount)} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.line}`);
    k++;
  }
  return `${out.join('\n')}\n`;
}
