// Path globs for config (components → paths, ignored checks). Wraps path.matchesGlob, which never
// throws on a malformed pattern, so validity is checked structurally here.
import { matchesGlob as nodeMatchesGlob } from 'node:path';

export function matchesGlob(path: string, pattern: string): boolean {
  return nodeMatchesGlob(path, pattern);
}

/** Non-empty, relative, no `..` segment, balanced [] and {}, no dangling escape. */
export function isValidGlob(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split('/').includes('..')) return false;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      if (i === p.length - 1) return false;
      i++;
      continue;
    }
    if (c === '[') square++;
    else if (c === ']' && square > 0) square--;
    else if (c === '{') curly++;
    else if (c === '}') {
      if (curly === 0) return false;
      curly--;
    }
  }
  return square === 0 && curly === 0;
}
