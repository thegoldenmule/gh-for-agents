// PR body templates (08 §2): a small logic-free language, so a project picks its body's layout in
// .github/ghx.json `render.prBody` without a template dependency.
//
// - `{{name}}` and `{{data.<key>}}` placeholders, substituted in one pass (values are never scanned again).
// - Paragraphs split on blank lines; a paragraph whose placeholders all render empty is dropped.
// - A heading line (`#`–`######`) is its own unit and opens a section that runs to the next heading of the same
//   or a higher level. A section with placeholders, every one empty, is dropped with its heading.
// - No loops, conditionals, partials, filters or escapes. The footer and the hidden block are not
//   placeholders: ghx appends them after the template, so no template can drop or move the block.
import { createHash } from 'node:crypto';
import type { IssueDetail } from '../core/errors.ts';
import { suggest } from '../core/suggest.ts';

/** Block placeholders: each alone in its paragraph. */
export const BLOCK_PLACEHOLDERS = ['description', 'trailer', 'howToTest', 'data'] as const;
/** Inline placeholders: anywhere in a paragraph's text. */
export const INLINE_PLACEHOLDERS = [
  'risk',
  'revertPolicy',
  'components',
  'testSummary',
  'riskNote',
  'revertNote',
] as const;
const REQUIRED = ['description', 'trailer'] as const;
export const MAX_TEMPLATE_CHARS = 4000;

/** The built-in templates `render.mode` names. Both have sections (08: "even if brief"). */
export const BUILTIN_TEMPLATES = {
  trailer: ['## Summary', '', '{{description}}', '', '{{trailer}}', '', '## Data', '', '{{data}}'].join('\n'),
  details: [
    '## Summary',
    '',
    '{{description}}',
    '',
    '{{trailer}}',
    '',
    '## How to test',
    '',
    '{{howToTest}}',
    '',
    '## Data',
    '',
    '{{data}}',
  ].join('\n'),
} as const;

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const DATA_PLACEHOLDER = /^data\.([a-z][a-zA-Z0-9_-]{0,39})$/;
const HEADING = /^(#{1,6})\s+\S/;
/** A literal line that would read as the trailer (drift detection anchors on the trailer). */
export const TRAILER_LIKE = /^Risk: [^\n]* · Components: /;

/** The template text a render config selects: `prBody` (string or lines), else the built-in for `mode`. */
export function templateText(render: {
  mode?: 'trailer' | 'details' | undefined;
  prBody?: string | readonly string[] | undefined;
}): string {
  const raw = render.prBody === undefined ? BUILTIN_TEMPLATES[render.mode ?? 'trailer'] : render.prBody;
  return (typeof raw === 'string' ? raw : raw.join('\n')).replace(/\r\n?/g, '\n').trim();
}

/** The `layout` a body records (08): 8 hex chars of the sha256 of the normalised template text. */
export function layoutOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

interface Section {
  heading: string | null;
  level: number;
  /** Paragraphs and subsections, in template order. */
  parts: (string | Section)[];
}

/** The template as a section tree. Heading lines are units of their own, even without a blank line. */
function tree(text: string): Section {
  const root: Section = { heading: null, level: 0, parts: [] };
  const stack: Section[] = [root];
  let para: string[] = [];
  const top = () => stack[stack.length - 1] ?? root;
  const flush = () => {
    if (para.length > 0) top().parts.push(para.join('\n'));
    para = [];
  };
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line);
    if (h?.[1] !== undefined) {
      flush();
      const level = h[1].length;
      while (stack.length > 1 && top().level >= level) stack.pop();
      const s: Section = { heading: line.trimEnd(), level, parts: [] };
      top().parts.push(s);
      stack.push(s);
    } else if (line.trim() === '') flush();
    else para.push(line);
  }
  flush();
  return root;
}

function paragraphs(s: Section): string[] {
  return s.parts.flatMap((p) => (typeof p === 'string' ? [p] : paragraphs(p)));
}
function headings(s: Section): string[] {
  return s.parts.flatMap((p) => (typeof p === 'string' ? [] : [p.heading ?? '', ...headings(p)]));
}

const isBlock = (n: string): boolean => (BLOCK_PLACEHOLDERS as readonly string[]).includes(n);
const isInline = (n: string): boolean => (INLINE_PLACEHOLDERS as readonly string[]).includes(n);
const VOCABULARY: readonly string[] = [...BLOCK_PLACEHOLDERS, ...INLINE_PLACEHOLDERS];

/**
 * Every problem with a template (08 §2 Validation), as config issues at `path`. `declared` is the
 * `data.fields` keys, which `{{data.<key>}}` must name. Empty when the template is valid.
 */
export function templateIssues(text: string, declared: readonly string[], path = 'render.prBody'): IssueDetail[] {
  const out: IssueDetail[] = [];
  const add = (code: string, message: string, suggestion?: string) =>
    out.push({ path, code: `render.prBody.${code}`, message, ...(suggestion !== undefined ? { suggestion } : {}) });
  if (text.length > MAX_TEMPLATE_CHARS) add('too_long', `${text.length} chars; at most ${MAX_TEMPLATE_CHARS}`);
  const t = tree(text);
  const seen = new Map<string, number>();
  for (const p of paragraphs(t)) {
    const names = [...p.matchAll(PLACEHOLDER)].map((m) => (m[1] ?? '').trim());
    const literal = p.replace(PLACEHOLDER, '');
    if (/\{\{|\}\}/.test(literal)) add('unterminated', `unbalanced {{ or }} in '${p.split('\n')[0]}'`);
    if (literal.includes('<!--')) add('html_comment', 'literal text must not contain an HTML comment (<!--)');
    for (const line of literal.split('\n')) {
      if (TRAILER_LIKE.test(line))
        add('trailer_like', `the literal line '${line}' reads as the trailer; use {{trailer}}`);
    }
    for (const name of names) {
      seen.set(name, (seen.get(name) ?? 0) + 1);
      const data = DATA_PLACEHOLDER.exec(name);
      if (data?.[1] !== undefined) {
        if (!declared.includes(data[1])) {
          const s = suggest(data[1], declared)[0];
          add(
            'undeclared_data_key',
            `{{${name}}} names a key data.fields does not declare${declared.length > 0 ? ` (${declared.join(', ')})` : ''}; use {{data}} for undeclared keys`,
            s === undefined ? undefined : `data.${s}`,
          );
        }
      } else if (!isBlock(name) && !isInline(name)) {
        // suggest() skips a case-only difference, the likeliest slip ({{risknote}}).
        const s = VOCABULARY.find((v) => v.toLowerCase() === name.toLowerCase()) ?? suggest(name, VOCABULARY)[0];
        add(
          'unknown_placeholder',
          `{{${name}}} is not a placeholder; use one of ${VOCABULARY.join(', ')} or data.<key>`,
          s,
        );
      } else if (isBlock(name) && (names.length !== 1 || literal.trim() !== '')) {
        add('not_alone', `{{${name}}} must be the only thing in its paragraph (blank lines around it)`);
      }
    }
  }
  for (const h of headings(t)) {
    if (/\{\{|\}\}/.test(h)) add('in_heading', `a heading is literal text; move the placeholder out of '${h}'`);
    if (h.includes('<!--')) add('html_comment', 'literal text must not contain an HTML comment (<!--)');
  }
  for (const [name, n] of seen) if (n > 1) add('repeated', `{{${name}}} appears ${n} times; at most once`);
  for (const r of REQUIRED) if (!seen.has(r)) add('missing_required', `the template must place {{${r}}}`);
  return out;
}

/** What each placeholder renders to; '' (or absent) is empty. */
export interface TemplateValues {
  [name: string]: string | undefined;
}

interface Rendered {
  out: string[];
  /** Placeholders in this section and its subsections. */
  placeholders: number;
  /** ...of which rendered non-empty. */
  filled: number;
}

function renderSection(s: Section, values: TemplateValues): Rendered {
  const out: string[] = [];
  let placeholders = 0;
  let filled = 0;
  for (const part of s.parts) {
    if (typeof part !== 'string') {
      const r = renderSection(part, values);
      placeholders += r.placeholders;
      filled += r.filled;
      out.push(...r.out);
      continue;
    }
    let here = 0;
    let full = 0;
    const text = part.replace(PLACEHOLDER, (_m, raw: string) => {
      const v = values[raw.trim()] ?? '';
      here++;
      if (v !== '') full++;
      return v;
    });
    placeholders += here;
    filled += full;
    if (here > 0 && full === 0) continue;
    if (text.trim() !== '') out.push(text);
  }
  if (s.heading === null) return { out, placeholders, filled };
  if (placeholders > 0 && filled === 0) return { out: [], placeholders, filled };
  return { out: [s.heading, ...out], placeholders, filled };
}

const compiled = new Map<string, Section>();

/** The visible markdown for `text` with `values`: paragraphs and headings joined by one blank line. */
export function renderTemplate(text: string, values: TemplateValues): string {
  let t = compiled.get(text);
  if (t === undefined) {
    t = tree(text);
    compiled.set(text, t);
  }
  return renderSection(t, values).out.join('\n\n');
}
