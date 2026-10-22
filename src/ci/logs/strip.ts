// Job-log cleaning (02 §12 step 2; 03 §5.1): the BOM, the runner's ISO timestamp prefix, gh's
// `--log-failed` prefix (`job\tUNKNOWN STEP\t<ts>`), ANSI SGR/CSI and OSC 8 hyperlinks, and lone-CR
// progress redraws (only the final state of the line is kept). Files are streamed line by line, so
// a multi-megabyte log is processed in bounded memory.

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';

const ESC = '\u001b';
const BEL = '\u0007';
/** OSC … BEL or OSC … ESC \ (hyperlinks keep their visible text, which sits between two OSCs). */
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
/** CSI sequences (SGR colours, cursor moves, erase-line). */
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
/** Any other two-byte escape, and a stray ESC. */
const ESC2 = new RegExp(`${ESC}[@-Z\\\\-_]?`, 'g');

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?:[ \t]|$)/;
/** gh run view --log / --log-failed: `<job>\t<step>\t<ts> ` (the step is often "UNKNOWN STEP"). */
const GH_PREFIX = /^[^\t\n]*\t[^\t\n]*\t(?=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;

export function stripAnsi(s: string): string {
  return s.replace(OSC, '').replace(CSI, '').replace(ESC2, '');
}

export interface StrippedLine {
  text: string;
  /** The runner timestamp that prefixed the line, if any. */
  ts: string | null;
}

export function stripLineWithTs(raw: string): StrippedLine {
  let s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  s = s.replace(/\r+$/, '');
  s = s.replace(GH_PREFIX, '');
  let ts: string | null = null;
  const m = TS.exec(s);
  if (m) {
    ts = m[1] ?? null;
    s = s.slice(m[0].length);
  }
  const cr = s.lastIndexOf('\r');
  if (cr !== -1) s = s.slice(cr + 1);
  return { text: stripAnsi(s), ts };
}

export function stripLine(raw: string): string {
  return stripLineWithTs(raw).text;
}

/** Strip a whole in-memory log; returns the cleaned lines. */
export function stripText(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(stripLine);
}

export interface StripResult {
  /** Bytes written to `dest`. */
  bytes: number;
  lines: number;
}

/**
 * Stream `src` to `dest`, one cleaned line at a time. `onLine` sees each cleaned line, its 0-based
 * index in `dest`, and its runner timestamp (for step attribution).
 */
export async function stripLogFile(
  src: string,
  dest: string,
  onLine?: (text: string, index: number, ts: string | null) => void,
): Promise<StripResult> {
  const out = createWriteStream(dest, { encoding: 'utf8' });
  let index = 0;
  let bytes = 0;
  let carry = '';
  const emit = async (raw: string): Promise<void> => {
    const { text, ts } = stripLineWithTs(raw);
    onLine?.(text, index, ts);
    index++;
    const chunk = `${text}\n`;
    bytes += Buffer.byteLength(chunk);
    if (!out.write(chunk)) await once(out, 'drain');
  };
  try {
    for await (const chunk of createReadStream(src, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
      const parts = (carry + (chunk as string)).split('\n');
      carry = parts.pop() ?? '';
      for (const p of parts) await emit(p);
    }
    if (carry !== '') await emit(carry);
  } finally {
    out.end();
    await once(out, 'close');
  }
  return { bytes, lines: index };
}
