// dataRules (08 §1): the agent data checks that cross values or need the config. A project's declared
// fields are a floor: each required one must be present and match its type; any other key is accepted.
import type { GhxConfig } from '../../config/schema.ts';
import type { DataField } from '../../config/sections/data.ts';
import type { IssueDetail } from '../../core/errors.ts';
import { suggest } from '../../core/suggest.ts';
import { type Data, MAX_DATA_BYTES, MAX_DATA_ITEMS, MAX_DATA_KEYS, MAX_DATA_STRING } from '../../schemas/data.ts';
import { riskRank } from '../../schemas/pr.ts';
import { stableStringify } from '../../util/json.ts';

export type DataRulesConfig = Pick<GhxConfig, 'data'>;

/** Token shapes that are credentials, never PR data (08: a tripwire, not a scanner). */
const SECRET_LIKE: readonly { name: string; re: RegExp }[] = [
  { name: 'ghp_…', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github_pat_…', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AKIA…', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '-----BEGIN …', re: /-----BEGIN [A-Z ]+-----/ },
];

const issue = (path: string, code: string, message: string): IssueDetail => ({ path, code, message });

/** Every string in a value, with its path below `data.<key>`. */
function strings(key: string, v: unknown): { path: string; text: string }[] {
  if (typeof v === 'string') return [{ path: `data.${key}`, text: v }];
  if (Array.isArray(v))
    return v.flatMap((x, i) => (typeof x === 'string' ? [{ path: `data.${key}[${i}]`, text: x }] : []));
  if (v !== null && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) =>
      typeof x === 'string' ? [{ path: `data.${key}.${k}`, text: x }] : [],
    );
  }
  return [];
}

/** True when the field is required at `risk` (unknown risk: only `required: true` counts). */
export function isRequired(f: DataField, risk: string | undefined): boolean {
  if (f.required === true) return true;
  return f.requiredFromRisk !== undefined && risk !== undefined && riskRank(risk) >= riskRank(f.requiredFromRisk);
}

/** What a declared field holds, for messages and --example. */
export function fieldShape(f: DataField): string {
  switch (f.type) {
    case 'string':
      return `a one-line string${f.pattern !== undefined ? ` matching ${f.pattern}` : ''}${f.maxChars !== undefined ? `, ≤${f.maxChars} chars` : ''}`;
    case 'enum':
      return `one of ${f.values.join(', ')}`;
    case 'number':
      return `a number${f.min !== undefined ? ` ≥ ${f.min}` : ''}${f.max !== undefined ? ` ≤ ${f.max}` : ''}`;
    case 'boolean':
      return 'true or false';
    case 'string[]':
      return `a list of one-line strings (≤${MAX_DATA_ITEMS})`;
  }
}

/** Why `v` does not fit the declared field, or null. Structure (one line, ≤300 chars) was checked by zod. */
function typeProblem(f: DataField, v: unknown): string | null {
  switch (f.type) {
    case 'string':
      if (typeof v !== 'string') return 'expected a string';
      if (f.maxChars !== undefined && [...v].length > f.maxChars) return `longer than ${f.maxChars} chars`;
      if (f.pattern !== undefined && !new RegExp(f.pattern, 'u').test(v)) return `does not match ${f.pattern}`;
      return null;
    case 'enum':
      return typeof v === 'string' && f.values.includes(v) ? null : `expected one of ${f.values.join(', ')}`;
    case 'number':
      if (typeof v !== 'number') return 'expected a number';
      if (f.min !== undefined && v < f.min) return `below the minimum ${f.min}`;
      if (f.max !== undefined && v > f.max) return `above the maximum ${f.max}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : 'expected true or false';
    case 'string[]':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'expected a list of strings';
  }
}

/**
 * The data rules (08 §1 Messages): data.too_many_keys, data.too_large, data.secret_like, data.required and
 * data.type. `risk` is absent while it failed to parse; requiredFromRisk then waits for it.
 */
export function dataRules(
  input: { data?: Data | undefined; risk?: string | undefined },
  config: DataRulesConfig,
): IssueDetail[] {
  const out: IssueDetail[] = [];
  const data = input.data ?? {};
  const keys = Object.keys(data);
  if (keys.length > MAX_DATA_KEYS) {
    out.push(issue('data', 'data.too_many_keys', `data has ${keys.length} keys; the limit is ${MAX_DATA_KEYS}`));
  }
  const bytes = Buffer.byteLength(stableStringify(data), 'utf8');
  if (bytes > MAX_DATA_BYTES) {
    out.push(
      issue(
        'data',
        'data.too_large',
        `data is ${bytes.toLocaleString('en-US')} bytes; the limit is ${MAX_DATA_BYTES.toLocaleString('en-US')}`,
      ),
    );
  }
  for (const k of keys) {
    for (const s of strings(k, data[k])) {
      const hit = SECRET_LIKE.find((p) => p.re.test(s.text));
      if (hit !== undefined) {
        out.push(issue(s.path, 'data.secret_like', `${s.path} looks like a credential (${hit.name}); data is public`));
      }
    }
  }

  const declared = config.data.fields;
  const extra = keys.filter((k) => !Object.hasOwn(declared, k));
  for (const [name, f] of Object.entries(declared)) {
    const v = data[name];
    if (v === undefined) {
      if (!isRequired(f, input.risk)) continue;
      const why =
        f.required === true
          ? 'is required by .github/ghx.json'
          : `is required at risk ${f.requiredFromRisk} and above (.github/ghx.json)`;
      const d = issue(`data.${name}`, 'data.required', `data.${name} ${why}: ${fieldShape(f)}`);
      const s = suggest(name, extra)[0];
      if (s !== undefined) {
        d.message += `; did you mean '${s}'?`;
        d.suggestion = s;
      }
      out.push(d);
      continue;
    }
    const problem = typeProblem(f, v);
    if (problem !== null) {
      out.push(issue(`data.${name}`, 'data.type', `data.${name}: ${problem}; got ${JSON.stringify(v)}`));
    }
  }
  return out;
}

/** An example value for a declared field, for --example. */
export function fieldExample(name: string, f: DataField): unknown {
  switch (f.type) {
    case 'string':
      return f.example ?? `<${name}>`;
    case 'enum':
      return f.values[0];
    case 'number':
      return f.example ?? f.min ?? 0;
    case 'boolean':
      return true;
    case 'string[]':
      return f.example ?? [`<${name}>`];
  }
}

/** The declared fields an example input at `risk` must carry, with example values. */
export function requiredExample(config: DataRulesConfig, risk: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(config.data.fields)) {
    if (isRequired(f, risk)) out[name] = fieldExample(name, f);
  }
  return out;
}

/** One rules line for --example and --schema. */
export function dataRulesSummary(config: DataRulesConfig): string {
  const fields = Object.entries(config.data.fields).map(([name, f]) => {
    const when =
      f.required === true
        ? 'required'
        : f.requiredFromRisk !== undefined
          ? `required from risk ${f.requiredFromRisk}`
          : 'optional';
    return `${name} (${when}; ${fieldShape(f)})`;
  });
  return (
    `data: optional {key: value}, ≤${MAX_DATA_KEYS} keys, ≤${MAX_DATA_BYTES} bytes; one-line strings ≤${MAX_DATA_STRING} chars, numbers, booleans, lists or one-level objects; shown in the body and in pr status meta.data; public` +
    (fields.length > 0 ? `; this repo declares ${fields.join(', ')}; add any other keys you need` : '')
  );
}
