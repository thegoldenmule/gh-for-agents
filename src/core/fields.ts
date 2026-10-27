// --fields and --brief (02 §1.1): keep only selected leaves of a command's output document.
//
// A path is dot-separated keys; `key[]` maps over an array. Projection rule (the contract): if the
// document has a top-level `results` array, paths resolve against each element and the other
// top-level keys are kept; otherwise they resolve against the document. `warnings` is always kept,
// and so is what names a results[] element and its failure (RESULT_KEEP): a failed PR in pr status
// N M is {selector, ref, error}, never {}. Paths are checked against the output schema before the command runs, so a typo fails
// as VALIDATION and never after a write. Error documents are never projected (emitDocument).
import { z } from 'zod';
import { type AnyCommandSpec, commandName, Warning } from './command.ts';
import { GhxError } from './errors.ts';
import { suggest } from './suggest.ts';

export interface FieldSegment {
  key: string;
  /** `key[]`: map over the array at `key`. */
  each: boolean;
}

export interface FieldPath {
  raw: string;
  segments: FieldSegment[];
}

/** The selected paths merged into a tree; a leaf keeps its whole subtree. */
export interface FieldNode {
  leaf: boolean;
  each: boolean;
  children: Map<string, FieldNode>;
}

const SEGMENT = /^([A-Za-z_$][\w$-]*)(\[\])?$/;

interface Issue {
  path: string;
  code: string;
  message: string;
}

function fieldsError(issues: Issue[], hint: string, details: Record<string, unknown> = {}): GhxError {
  return new GhxError('VALIDATION', `${issues.length} --fields issue${issues.length === 1 ? '' : 's'}.`, {
    hint,
    details: { issues, ...details },
  });
}

/** Parse comma-separated paths (each --fields value may hold several). Syntax errors are VALIDATION. */
export function parseFields(values: readonly string[]): FieldPath[] {
  const out: FieldPath[] = [];
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const raw of values.flatMap((v) => v.split(',')).map((s) => s.trim())) {
    if (raw === '' || seen.has(raw)) continue;
    seen.add(raw);
    const segments: FieldSegment[] = [];
    for (const part of raw.split('.')) {
      const m = SEGMENT.exec(part);
      if (!m) {
        issues.push({ path: '--fields', code: 'invalid_path', message: `'${raw}' is not a field path` });
        break;
      }
      segments.push({ key: m[1] as string, each: m[2] !== undefined });
    }
    if (segments.length === raw.split('.').length) out.push({ raw, segments });
  }
  if (issues.length > 0) {
    throw fieldsError(issues, `${issues[0]?.message}: write dot paths with [] over arrays, e.g. ci.failing[].name`);
  }
  if (out.length === 0) {
    throw fieldsError(
      [{ path: '--fields', code: 'invalid_path', message: 'no field paths given' }],
      'Pass comma-separated paths, e.g. --fields state,head.sha',
    );
  }
  return out;
}

export function fieldTree(paths: readonly FieldPath[]): FieldNode {
  const root: FieldNode = { leaf: false, each: false, children: new Map() };
  for (const p of paths) {
    let node = root;
    p.segments.forEach((s, i) => {
      let child = node.children.get(s.key);
      if (!child) {
        child = { leaf: false, each: false, children: new Map() };
        node.children.set(s.key, child);
      }
      if (s.each) child.each = true;
      // `ci.failing` and `ci.failing[].name` together: the whole array wins.
      if (i === p.segments.length - 1) child.leaf = true;
      node = child;
    });
  }
  return root;
}

/** Kept in every results[] element whatever the paths: its identity, its failure and its warnings. */
export const RESULT_KEEP = ['selector', 'ref', 'target', 'error', 'warnings'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function projectObject(obj: Record<string, unknown>, node: FieldNode, keep: readonly string[] = []): unknown {
  const out: Record<string, unknown> = {};
  // Document key order, not --fields order: the projection reads like the full output.
  for (const [k, v] of Object.entries(obj)) {
    const child = node.children.get(k);
    if (child) out[k] = projectValue(v, child);
    else if (keep.includes(k)) out[k] = v;
  }
  return out;
}

function projectValue(v: unknown, node: FieldNode): unknown {
  if (node.leaf) return v;
  // null mid-path stays null (meta.rev on a PR without a block is meta: null).
  if (Array.isArray(v)) return node.each ? v.map((e) => (isRecord(e) ? projectObject(e, node) : e)) : v;
  return isRecord(v) ? projectObject(v, node) : v;
}

/** Apply the projection rule to one output document. */
export function projectDocument(doc: unknown, tree: FieldNode): unknown {
  if (!isRecord(doc)) return doc;
  const results = doc.results;
  if (!Array.isArray(results)) return projectObject(doc, tree, ['warnings']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    out[k] = k === 'results' ? results.map((e) => (isRecord(e) ? projectObject(e, tree, RESULT_KEEP) : e)) : v;
  }
  return out;
}

// ── Checking paths against the output schema ────────────────────────────────────────────────────

type Js = {
  type?: string | string[];
  properties?: Record<string, Js>;
  additionalProperties?: boolean | Js;
  items?: Js;
  anyOf?: Js[];
  oneOf?: Js[];
  allOf?: Js[];
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  $defs?: Record<string, Js>;
};

const hasType = (n: Js, t: string): boolean => (Array.isArray(n.type) ? n.type.includes(t) : n.type === t);

/** The concrete branches of a node: $refs resolved, unions flattened. */
function branches(n: Js | undefined, defs: Record<string, Js>, depth = 0): Js[] {
  if (!n || depth > 32) return [];
  if (n.$ref) return branches(defs[n.$ref.split('/').pop() ?? ''], defs, depth + 1);
  const alts = [...(n.anyOf ?? []), ...(n.oneOf ?? []), ...(n.allOf ?? [])];
  if (alts.length > 0) return alts.flatMap((a) => branches(a, defs, depth + 1));
  return [n];
}

/** `{}` (z.unknown) or a record of anything: any path below is accepted. */
const isOpen = (n: Js): boolean =>
  n.type === undefined &&
  n.properties === undefined &&
  n.items === undefined &&
  n.enum === undefined &&
  !('const' in n);
const isObject = (n: Js): boolean => hasType(n, 'object') || n.properties !== undefined;
const isArray = (n: Js): boolean => hasType(n, 'array');
const keysOf = (ns: readonly Js[]): string[] => [...new Set(ns.flatMap((n) => Object.keys(n.properties ?? {})))];

/** Why `p` does not resolve against `roots`, or undefined when it does. */
function pathProblem(p: FieldPath, roots: readonly Js[], defs: Record<string, Js>): string | undefined {
  let nodes = roots.flatMap((r) => branches(r, defs));
  let at = '';
  for (const [i, s] of p.segments.entries()) {
    if (nodes.some(isOpen)) return undefined;
    const objects = nodes.filter(isObject);
    if (objects.length === 0) {
      return nodes.some(isArray)
        ? `'${at}' is an array: write '${at}[].${p.segments
            .slice(i)
            .map((x) => `${x.key}${x.each ? '[]' : ''}`)
            .join('.')}'`
        : `'${at}' has no fields`;
    }
    const next = objects.flatMap((o) => {
      const prop = o.properties?.[s.key];
      if (prop) return [prop];
      const extra = o.additionalProperties;
      return extra === true ? [{}] : extra && typeof extra === 'object' ? [extra] : [];
    });
    if (next.length === 0) {
      const keys = keysOf(objects);
      const near = suggest(s.key, keys);
      const where = at === '' ? 'the output' : `'${at}'`;
      return `'${s.key}' is not a field of ${where}${near.length > 0 ? ` (did you mean '${near[0]}'?)` : ''}; fields: ${keys.join(', ')}`;
    }
    at = at === '' ? s.key : `${at}.${s.key}`;
    const resolved = next.flatMap((n) => branches(n, defs));
    if (s.each) {
      if (resolved.some(isOpen)) return undefined;
      const arrays = resolved.filter(isArray);
      if (arrays.length === 0) return `'${at}' is not an array: drop the []`;
      nodes = arrays.map((a) => a.items ?? {});
      at = `${at}[]`;
    } else {
      nodes = resolved;
    }
  }
  return undefined;
}

const schemaCache = new WeakMap<z.ZodType, Js>();

/** The JSON Schema of a spec's stdout document (output, or a stream's summary), with `warnings`. */
function outputJson(spec: AnyCommandSpec): Js {
  const base = spec.mode === 'single' ? spec.output : spec.summarySchema;
  let js = schemaCache.get(base);
  if (!js) {
    const schema = base.extend({ warnings: Warning.array().optional() });
    js = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Js;
    schemaCache.set(base, js);
  }
  return js;
}

/**
 * The roots paths resolve against: a document that always has `results[]` resolves against its
 * elements; one that may have it (an optional `results`) against either.
 */
function rootsOf(js: Js, defs: Record<string, Js>): { roots: Js[]; perResult: boolean } {
  const results = js.properties?.results;
  const arrays = branches(results, defs).filter(isArray);
  if (arrays.length === 0) return { roots: [js], perResult: false };
  const items = arrays.map((a) => a.items ?? {});
  return js.required?.includes('results')
    ? { roots: items, perResult: true }
    : { roots: [js, ...items], perResult: false };
}

/** Throw VALIDATION unless every path resolves in the command's output schema. */
export function checkFields(spec: AnyCommandSpec, paths: readonly FieldPath[]): void {
  const js = outputJson(spec);
  const defs = js.$defs ?? {};
  const { roots, perResult } = rootsOf(js, defs);
  const issues: Issue[] = [];
  for (const p of paths) {
    let problem = pathProblem(p, roots, defs);
    if (problem && perResult && p.segments[0]?.key === 'results') {
      const rest = p.segments
        .slice(1)
        .map((x) => `${x.key}${x.each ? '[]' : ''}`)
        .join('.');
      problem = `paths resolve against each results[] element: write '${rest || '…'}'`;
    }
    if (problem) issues.push({ path: '--fields', code: 'unknown_field', message: `${p.raw}: ${problem}` });
  }
  if (issues.length === 0) return;
  const top = keysOf(roots.flatMap((r) => branches(r, defs)));
  const scope = perResult
    ? 'Fields of each results[] element (other top-level keys are always kept)'
    : 'Top-level fields';
  throw fieldsError(
    issues,
    `${issues[0]?.message}. ${scope}: ${top.join(', ')}. See ghx ${commandName(spec)} --schema.`,
    {
      fields: top,
    },
  );
}

export interface FieldOptions {
  fields?: readonly string[] | undefined;
  brief?: boolean | undefined;
}

/**
 * Resolve --fields and --brief for a spec into a projection, or undefined when neither is given.
 * --brief with --fields selects the union. Throws before the command runs.
 */
export function fieldProjection(spec: AnyCommandSpec, o: FieldOptions): ((doc: unknown) => unknown) | undefined {
  const values: string[] = [];
  if (o.brief) {
    if (!spec.brief || spec.brief.length === 0) {
      throw new GhxError('USAGE_UNKNOWN_FLAG', `'ghx ${commandName(spec)}' has no flag '--brief'.`, {
        hint: `This command has no brief preset; pick fields with --fields (see ghx ${commandName(spec)} --schema).`,
        details: { flag: '--brief', suggestions: ['--fields'] },
      });
    }
    values.push(spec.brief.join(','));
  }
  if (o.fields !== undefined) values.push(...o.fields);
  if (values.length === 0) return undefined;
  const paths = parseFields(values);
  checkFields(spec, paths);
  const tree = fieldTree(paths);
  return (doc) => projectDocument(doc, tree);
}
