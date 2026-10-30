// --fields and --brief (02 §1.1): keep only selected leaves of a command's output document.
//
// A path is dot-separated keys. A path through an array maps over its elements, so `ci.failing.name`
// and `ci.failing[].name` are the same path; `[]` is optional (and unquoted, zsh globs it, so the
// hints never write it). Projection rule (the contract): if the document has a top-level `results`
// array, paths resolve against each element and the other top-level keys are kept; otherwise they
// resolve against the document. `warnings` is always kept, and so is what names a results[] element
// and its failure (RESULT_KEEP): a failed PR in pr status N M is {selector, ref, error}, never {}.
// Paths are checked against the output schema before the command runs, so a typo fails as VALIDATION
// and never after a write. Error documents are never projected (emitDocument), so `error` is always
// an allowed path.
import { z } from 'zod';
import { type AnyCommandSpec, commandName, Warning } from './command.ts';
import { DryRunEnvelope } from './envelopes.ts';
import { GhxError } from './errors.ts';
import { editDistance, suggest } from './suggest.ts';

export interface FieldSegment {
  key: string;
  /** Written `key[]`. Arrays are mapped over either way; this only lets a `[]` on a non-array be refused. */
  each: boolean;
}

export interface FieldPath {
  raw: string;
  segments: FieldSegment[];
}

/** The selected paths merged into a tree; a leaf keeps its whole subtree. */
export interface FieldNode {
  leaf: boolean;
  children: Map<string, FieldNode>;
}

const SEGMENT = /^([A-Za-z_$][\w$-]*)(\[\])?$/;

interface Issue {
  path: string;
  code: string;
  message: string;
  /** The closest real paths, best first. */
  suggestions?: string[];
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
    throw fieldsError(issues, `${issues[0]?.message}: write dot paths, e.g. ci.failing.name (arrays are mapped over)`);
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
  const root: FieldNode = { leaf: false, children: new Map() };
  for (const p of paths) {
    let node = root;
    p.segments.forEach((s, i) => {
      let child = node.children.get(s.key);
      if (!child) {
        child = { leaf: false, children: new Map() };
        node.children.set(s.key, child);
      }
      // `ci.failing` and `ci.failing.name` together: the whole array wins.
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
  // A path through an array maps over it (nested arrays too), with or without `[]`: an open schema
  // (passthrough.json) cannot say what is an array, so the document decides.
  if (Array.isArray(v)) return v.map((e) => projectValue(e, node));
  // null mid-path stays null (meta.rev on a PR without a block is meta: null).
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

/** The nodes with every array (nested ones too) replaced by its items: a key after an array maps over it. */
function throughArrays(nodes: readonly Js[], defs: Record<string, Js>): Js[] {
  let out = [...nodes];
  for (let depth = 0; depth < 8 && out.some(isArray); depth++) {
    out = out.flatMap((n) => (isArray(n) ? branches(n.items ?? {}, defs) : [n]));
  }
  return out;
}

/** Why a path does not resolve: an unknown key (with what was there instead), or a plain reason. */
type Problem = { index: number; key: string; where: string; keys: string[] } | { text: string };

/** Why `p` does not resolve against `roots`, or undefined when it does. */
function pathProblem(p: FieldPath, roots: readonly Js[], defs: Record<string, Js>): Problem | undefined {
  let nodes = roots.flatMap((r) => branches(r, defs));
  let at = '';
  for (const [index, s] of p.segments.entries()) {
    nodes = throughArrays(nodes, defs);
    if (nodes.some(isOpen)) return undefined;
    const objects = nodes.filter(isObject);
    if (objects.length === 0) return { text: `'${at}' has no fields` };
    const next = objects.flatMap((o) => {
      const prop = o.properties?.[s.key];
      if (prop) return [prop];
      const extra = o.additionalProperties;
      return extra === true ? [{}] : extra && typeof extra === 'object' ? [extra] : [];
    });
    if (next.length === 0) {
      return { index, key: s.key, where: at === '' ? 'the output' : `'${at}'`, keys: keysOf(objects) };
    }
    at = at === '' ? s.key : `${at}.${s.key}`;
    const resolved = next.flatMap((n) => branches(n, defs));
    if (s.each && !resolved.some(isOpen) && !resolved.some(isArray))
      return { text: `'${at}' is not an array: drop the []` };
    nodes = resolved;
  }
  return undefined;
}

/** A document shape paths resolve against (see rootsOf). */
interface Shape {
  roots: Js[];
  defs: Record<string, Js>;
  perResult: boolean;
}

/** How deep allPaths goes: past it, the parent's field list in the message still helps. */
const PATH_DEPTH = 5;

/** Every path of a shape, dotted and without [] (arrays are mapped over), at most PATH_DEPTH deep. */
function allPaths(shape: Shape): string[] {
  const out = new Set<string>();
  const walk = (nodes: readonly Js[], prefix: string, depth: number): void => {
    if (depth >= PATH_DEPTH || out.size > 5_000) return;
    const objects = throughArrays(nodes, shape.defs).filter(isObject);
    for (const key of keysOf(objects)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      out.add(path);
      const next = objects.flatMap((o) => (o.properties?.[key] ? branches(o.properties[key], shape.defs) : []));
      walk(next, path, depth + 1);
    }
  };
  walk(
    shape.roots.flatMap((r) => branches(r, shape.defs)),
    '',
    0,
  );
  return [...out];
}

/**
 * The candidates closest to `p`, best first: by edit distance over the whole dotted path (a case-only
 * difference is nearest), with a missing or extra prefix counted as near (`failing.name` →
 * `ci.failing.name`) and the same leaf elsewhere next (`merge.failing` → `ci.failing`).
 */
export function closestPaths(p: FieldPath, candidates: readonly string[], max = 3): string[] {
  const want = p.segments
    .map((s) => s.key)
    .join('.')
    .toLowerCase();
  const last = want.split('.').at(-1) ?? want;
  const limit = Math.max(2, Math.ceil(want.length / 4));
  const scored = new Map<string, number>();
  for (const c of candidates) {
    const lc = c.toLowerCase();
    let d = lc === want ? 0.5 : editDistance(want, lc);
    if (lc.endsWith(`.${want}`) || want.endsWith(`.${lc}`)) d = Math.min(d, 1);
    else if (lc.split('.').at(-1) === last) d = Math.min(d, 2);
    if (d <= limit && d < (scored.get(c) ?? Number.POSITIVE_INFINITY)) scored.set(c, d);
  }
  const ranked = [...scored].sort(([a, x], [b, y]) => x - y || a.length - b.length || a.localeCompare(b));
  // Within one of the best: a near miss is not diluted by every path that shares its leaf name.
  const best = ranked[0]?.[1] ?? 0;
  return ranked
    .filter(([, d]) => d < best + 1)
    .slice(0, max)
    .map(([c]) => c);
}

const schemaCache = new WeakMap<z.ZodType, Shape>();

/**
 * The shape of a schema's document, with `warnings`. A document that always has `results[]` resolves
 * against its elements; one that may have it (an optional `results`) against either.
 */
function shapeOf(base: z.ZodObject): Shape {
  let shape = schemaCache.get(base);
  if (!shape) {
    const schema = base.extend({ warnings: Warning.array().optional() });
    const js = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Js;
    const defs = js.$defs ?? {};
    const arrays = branches(js.properties?.results, defs).filter(isArray);
    const items = arrays.map((a) => a.items ?? {});
    shape =
      arrays.length === 0
        ? { roots: [js], defs, perResult: false }
        : js.required?.includes('results')
          ? { roots: items, defs, perResult: true }
          : { roots: [js, ...items], defs, perResult: false };
    schemaCache.set(base, shape);
  }
  return shape;
}

/** The shape of a spec's stdout document: its output, or a stream's summary. */
const outputShape = (spec: AnyCommandSpec): Shape => shapeOf(spec.mode === 'single' ? spec.output : spec.summarySchema);

/** The --dry-run envelope's top-level keys a command's output never has (pr create): they select the envelope. */
const DRY_RUN_KEYS = ['wouldRun', 'preview'] as const;

/**
 * `error`/`error.*` names the error envelope, which is never projected (emitDocument): such a path is
 * always allowed, and selects nothing in a document that has no `error` of its own.
 */
const namesError = (p: FieldPath): boolean => p.segments[0]?.key === 'error';

/** The paths to project the command's output with, and the --dry-run envelope with. */
export interface CheckedFields {
  output: FieldPath[];
  dryRun: FieldPath[];
}

/**
 * Throw VALIDATION unless every path resolves in the command's output schema (or, with `dryRun`, in
 * that or the dry-run envelope); return the paths each document is projected with. An `error` path the
 * output does not have is accepted and left out of both.
 */
export function checkFields(
  spec: AnyCommandSpec,
  paths: readonly FieldPath[],
  o: { dryRun?: boolean | undefined } = {},
): CheckedFields {
  const shape = outputShape(spec);
  const envelope = o.dryRun ? shapeOf(DryRunEnvelope) : undefined;
  const issues: Issue[] = [];
  const kept: CheckedFields = { output: [], dryRun: [] };
  for (const p of paths) {
    const problem = pathProblem(p, shape.roots, shape.defs);
    const inEnvelope = envelope !== undefined && pathProblem(p, envelope.roots, envelope.defs) === undefined;
    if (!problem) kept.output.push(p);
    if (inEnvelope) kept.dryRun.push(p);
    if (!problem || inEnvelope || namesError(p)) continue;
    issues.push(fieldIssue(p, problem, shape, envelope));
  }
  if (issues.length === 0) return kept;
  const top = keysOf(shape.roots.flatMap((r) => branches(r, shape.defs)));
  const scope = shape.perResult
    ? 'Fields of each results[] element (other top-level keys are always kept)'
    : 'Top-level fields';
  const dry = envelope ? ` With --dry-run, also the envelope's: dryRun, ${DRY_RUN_KEYS.join(', ')}.` : '';
  throw fieldsError(issues, `${issues[0]?.message}. ${scope}: ${top.join(', ')}.${dry} ${seeFields(spec)}`, {
    fields: top,
  });
}

/**
 * `p` with the segment that failed replaced by a near key that was there (`runid` → `runId`), when the
 * result resolves: this reaches paths past allPaths' depth and below an open node (`previw.title`).
 */
function segmentFixes(p: FieldPath, problem: Problem | undefined, shape: Shape): string[] {
  if (!problem || 'text' in problem) return [];
  const lower = problem.key.toLowerCase();
  const near = [...problem.keys.filter((k) => k.toLowerCase() === lower), ...suggest(problem.key, problem.keys)];
  return near.flatMap((k) => {
    const segments = p.segments.map((s, i) => (i === problem.index ? { key: k, each: false } : s));
    const fixed: FieldPath = { raw: segments.map((s) => s.key).join('.'), segments };
    return pathProblem(fixed, shape.roots, shape.defs) === undefined ? [fixed.raw] : [];
  });
}

function fieldIssue(p: FieldPath, problem: Problem, shape: Shape, envelope: Shape | undefined): Issue {
  if (shape.perResult && p.segments[0]?.key === 'results') {
    const rest = p.segments
      .slice(1)
      .map((x) => x.key)
      .join('.');
    const message = `${p.raw}: paths resolve against each results[] element: write '${rest || '…'}'`;
    return { path: '--fields', code: 'unknown_field', message };
  }
  if ('text' in problem) return { path: '--fields', code: 'unknown_field', message: `${p.raw}: ${problem.text}` };
  const shapes = envelope ? [shape, envelope] : [shape];
  const near = closestPaths(
    p,
    shapes.flatMap((sh) => [...segmentFixes(p, pathProblem(p, sh.roots, sh.defs), sh), ...allPaths(sh)]),
  );
  const mean = near.length > 0 ? ` (did you mean ${near.map((n) => `'${n}'`).join(' or ')}?)` : '';
  // A top-level miss: the hint lists the top-level fields once, after the issue.
  const fields = problem.index === 0 ? '' : `; fields: ${problem.keys.join(', ')}`;
  return {
    path: '--fields',
    code: 'unknown_field',
    message: `${p.raw}: '${problem.key}' is not a field of ${problem.where}${mean}${fields}`,
    ...(near.length > 0 ? { suggestions: near } : {}),
  };
}

const seeFields = (spec: AnyCommandSpec): string => spec.fieldsHint ?? `See ghx ${commandName(spec)} --schema.`;

export interface FieldOptions {
  fields?: readonly string[] | undefined;
  brief?: boolean | undefined;
  /** --dry-run: paths may also name the dry-run envelope ({dryRun, wouldRun, preview, warnings}). */
  dryRun?: boolean | undefined;
}

/** What --fields and --brief resolve to; each projection is undefined when it keeps the whole document. */
export interface Projection {
  /** The command's output document (a stream's summary). */
  project: ((doc: unknown) => unknown) | undefined;
  /**
   * The --dry-run envelope, projected only when a path names its own keys (preview.title, wouldRun):
   * the command's output paths (--brief) describe a document a dry run does not print. It keeps
   * `dryRun` and `warnings`.
   */
  dryRun: ((doc: unknown) => unknown) | undefined;
  /** Warnings for the run's document (added to the command's own). */
  warnings: Warning[];
}

const projector = (paths: readonly FieldPath[]): ((doc: unknown) => unknown) => {
  const tree = fieldTree(paths);
  return (doc) => projectDocument(doc, tree);
};

/**
 * Resolve --fields and --brief for a spec, before the command runs. --brief with --fields selects
 * the union. Throws VALIDATION on a path that resolves nowhere.
 */
export function fieldProjection(spec: AnyCommandSpec, o: FieldOptions): Projection {
  const warnings: Warning[] = [];
  const values: string[] = [];
  if (o.brief) {
    // A command without a preset prints in full: --brief asks for less, never for an error.
    if (!spec.brief || spec.brief.length === 0) warnings.push(noPreset(spec, o.fields !== undefined));
    else values.push(spec.brief.join(','));
  }
  if (o.fields !== undefined) values.push(...o.fields);
  if (values.length === 0) return { project: undefined, dryRun: undefined, warnings };
  const checked = checkFields(spec, parseFields(values), { dryRun: o.dryRun });
  const own = checked.dryRun.some((p) => DRY_RUN_KEYS.some((k) => k === p.segments[0]?.key));
  return {
    // Only `error` paths: a failure prints the whole envelope anyway, and a success prints in full.
    project: checked.output.length > 0 ? projector(checked.output) : undefined,
    dryRun: own ? projector([...checked.dryRun, ...parseFields(['dryRun'])]) : undefined,
    warnings,
  };
}

const noPreset = (spec: AnyCommandSpec, withFields: boolean): Warning => ({
  code: 'BRIEF_NO_PRESET',
  message: `ghx ${commandName(spec)} has no --brief preset, so ${withFields ? 'only --fields applies' : 'the output is printed in full'}. Pick fields with --fields. ${seeFields(spec)}`,
});
