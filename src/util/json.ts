// Stable JSON (sorted keys, so edits diff cleanly) and JSON parsing with line/column positions.

function sortValue(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) throw new TypeError('stableStringify: circular structure');
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortValue(x, seen)));
    const toJSON = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') return sortValue(toJSON.call(v), seen);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
      out[k] = sortValue(x, seen);
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

/** JSON.stringify with object keys sorted at every depth. `indent` as in JSON.stringify. */
export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortValue(value, new WeakSet()), null, indent);
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string; line: number | null; column: number | null };

/** 1-based line and column of a UTF-16 offset. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { line, column: col };
}

/** JSON.parse that reports a 1-based line and column on failure instead of throwing. A leading BOM is ignored. */
export function parseJsonWithPosition(text: string): JsonParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { ok: true, value: JSON.parse(src) };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    let line: number | null = null;
    let column: number | null = null;
    const lc = /\(line (\d+) column (\d+)\)/.exec(raw);
    const pos = /at position (\d+)/.exec(raw);
    if (lc) {
      line = Number(lc[1]);
      column = Number(lc[2]);
    } else if (pos) {
      ({ line, column } = lineColumnAt(src, Number(pos[1])));
    } else if (/Unexpected end of JSON input/.test(raw)) {
      ({ line, column } = lineColumnAt(src, src.length));
    }
    const message = raw.replace(/\s*\(line \d+ column \d+\)/, '').replace(/,? ?"[^"]*"\.\.\. is not valid JSON$/, '');
    return { ok: false, message, line, column };
  }
}
