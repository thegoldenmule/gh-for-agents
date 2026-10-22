// "90s" / "10m" / "2h" / "1h30m" / "500ms" parsing for --timeout and friends.

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export type DurationResult = { ok: true; ms: number } | { ok: false; message: string };

export function parseDuration(input: string): DurationResult {
  const s = input.trim().toLowerCase();
  if (s === '') return { ok: false, message: 'empty duration' };
  if (/^\d+(\.\d+)?$/.test(s)) {
    return { ok: false, message: `'${input}' has no unit; use e.g. 90s, 10m or 2h` };
  }
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    if (m.index !== consumed) break;
    total += Number(m[1]) * (UNIT_MS[m[2] ?? ''] ?? Number.NaN);
    consumed += m[0].length;
  }
  if (consumed !== s.length || !Number.isFinite(total)) {
    return { ok: false, message: `'${input}' is not a duration; use e.g. 90s, 10m, 2h or 1h30m` };
  }
  return { ok: true, ms: Math.round(total) };
}

/** Compact human form: 90000 → "1m30s", 500 → "500ms". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  let rest = Math.round(ms / 1000);
  const h = Math.floor(rest / 3600);
  rest -= h * 3600;
  const m = Math.floor(rest / 60);
  const sec = rest - m * 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${sec || (!h && !m) ? `${sec}s` : ''}`;
}
