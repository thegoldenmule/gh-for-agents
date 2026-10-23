// The CLAUDE.md block `ghx install` maintains: docs/agents/claude-md-snippet.md between two marker
// lines. Install appends it once and replaces it in place afterwards; uninstall removes exactly it.
import { GhxError } from '../core/errors.ts';
import { styleOf, toPlain, withStyle } from './text.ts';

export const BEGIN = '<!-- ghx:begin -->';
export const END = '<!-- ghx:end -->';

export function ghxBlock(snippet: string): string {
  return `${BEGIN}\n${snippet.trim()}\n${END}`;
}

/** Offsets of each line that is exactly `marker` (ignoring trailing whitespace and CR). */
function markerLines(text: string, marker: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    if (line.trimEnd() === marker) out.push({ start: pos, end: pos + line.length });
    pos += line.length + 1;
  }
  return out;
}

/** The marked block's [start, end) span, or null. Unbalanced or repeated markers throw. */
export function findBlock(text: string, path: string): { start: number; end: number } | null {
  const begins = markerLines(text, BEGIN);
  const ends = markerLines(text, END);
  if (begins.length === 0 && ends.length === 0) return null;
  const b = begins[0];
  const e = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || !b || !e || e.start < b.end) {
    throw new GhxError(
      'INSTALL_CLAUDE_MD_INVALID',
      `${path}: expected one '${BEGIN}' line followed by one '${END}' line; found ${begins.length} and ${ends.length}.`,
      {
        hint: 'Remove the stray marker lines by hand, then run the command again. ghx changed nothing.',
        details: { path, begins: begins.length, ends: ends.length },
      },
    );
  }
  return { start: b.start, end: e.end };
}

/** The file with the ghx block added (appended after a blank line) or replaced in place, in the file's BOM and line endings. */
export function installBlock(text: string | null, snippet: string, path: string): string {
  return withStyle(installPlain(text === null ? null : toPlain(text), snippet, path), styleOf(text));
}

function installPlain(text: string | null, snippet: string, path: string): string {
  const block = ghxBlock(toPlain(snippet));
  const src = text ?? '';
  const span = findBlock(src, path);
  if (span) return src.slice(0, span.start) + block + src.slice(span.end);
  if (src === '') return `${block}\n`;
  return `${src}${src.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
}

/** The file without the ghx block and the blank line install put before it. Unchanged when absent. */
export function removeBlock(original: string, path: string): string {
  const text = toPlain(original);
  const span = findBlock(text, path);
  if (!span) return original;
  let before = text.slice(0, span.start);
  let after = text.slice(span.end);
  if (after.startsWith('\n')) after = after.slice(1);
  if (before.endsWith('\n\n')) before = before.slice(0, -1);
  else if (before === '' && after.startsWith('\n')) after = after.slice(1);
  const out = before + after;
  return out === '' ? '' : withStyle(out, styleOf(original));
}
