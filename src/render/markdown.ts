// Pure markdown helpers shared by the body renderers (01 §6): inline code, trailer joins, paragraphs.

/** `s` as inline code, with a fence longer than any backtick run inside it (CommonMark). */
export function inlineCode(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** One compact trailer line: `a · b · c`. Empty parts are dropped. */
export function joinTrailer(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
}

/** Paragraphs separated by one blank line. Null, undefined and blank parts are dropped. */
export function joinParagraphs(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n');
}
