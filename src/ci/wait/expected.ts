// The expected-check set and phases (02 §11.3; 03 M4.1). Pure: the gh reads live in ./fetch.ts.
// Sources, highest priority first: `required` (rules + branch protection summary + isRequired; the
// admin-only `…/protection` is never used, spike §3.2), `config` (`ci.expected`, path-filtered) and
// `baseline` (previous head, else last merged PR, else base head at `confidence: "low"`).
// Outputs are plain JSON so the wait state store (M4.6) can persist them as is.
import type { Check, CiSummary, ExpectedCheck } from '../../schemas/ci.ts';
import { matchesGlob } from '../../util/glob.ts';
import { type IgnoreRule, ignoreRuleFor } from '../checks.ts';
import { ciState } from '../summary.ts';

export type CiPhase = CiSummary['phase'];
export type ExpectedSource = ExpectedCheck['source'];
export type BaselineSource = 'previous-head' | 'last-merged-pr' | 'base-head';
export type BaselineConfidence = 'high' | 'medium' | 'low';

export const BASELINE_ORDER: readonly BaselineSource[] = ['previous-head', 'last-merged-pr', 'base-head'];
export const BASELINE_CONFIDENCE: Readonly<Record<BaselineSource, BaselineConfidence>> = {
  'previous-head': 'high',
  'last-merged-pr': 'medium',
  'base-head': 'low',
};

/** One entry of `GET rules/branches/<base>` (only the fields read here). */
export interface BranchRule {
  type: string;
  ruleset_source_type?: string | null | undefined;
  parameters?: { required_status_checks?: readonly { context: string }[] | null | undefined } | null | undefined;
}

/** The two required-check endpoints. `null` means that source is unknown (a 404), not empty. */
export interface RequiredSources {
  rules: readonly string[] | null;
  branch: readonly string[] | null;
}

/** One `ci.expected` entry (config/sections/ci.ts). */
export interface ConfigExpectedEntry {
  name: string;
  workflow?: string | undefined;
  paths?: readonly string[] | undefined;
}

/** Check names observed on one commit, for one baseline source. `names: null` = not available. */
export interface BaselineCandidate {
  source: BaselineSource;
  sha: string | null;
  names: readonly string[] | null;
}

export interface Baseline {
  source: BaselineSource;
  sha: string;
  confidence: BaselineConfidence;
  names: string[];
}

/** An expected check before matching against the reported checks. */
export interface ExpectedDef {
  name: string;
  workflow: string | null;
  source: ExpectedSource;
}

const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)];

/** Contexts of every `required_status_checks` rule, deduplicated; repository and org rulesets alike. */
export function rulesRequiredContexts(rules: readonly BranchRule[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (r.type !== 'required_status_checks') continue;
    for (const c of r.parameters?.required_status_checks ?? []) if (c.context) out.push(c.context);
  }
  return uniq(out);
}

/** The required set: both endpoints plus reported checks with `isRequired`, deduplicated, in that order. */
export function requiredChecks(
  src: RequiredSources,
  reported: readonly Pick<Check, 'name' | 'required'>[] = [],
): string[] {
  return uniq([...(src.rules ?? []), ...(src.branch ?? []), ...reported.filter((c) => c.required).map((c) => c.name)]);
}

/**
 * The `ci.expected` entries that apply. An entry without `paths` always applies; one with `paths`
 * applies when a changed file matches a glob. `changedFiles: null` (unknown) keeps every entry, so an
 * unknown file list can delay green but never cause an early one.
 */
export function configExpected(
  entries: readonly ConfigExpectedEntry[],
  changedFiles: readonly string[] | null,
): ConfigExpectedEntry[] {
  return entries.filter((e) => {
    if (!e.paths || changedFiles === null) return true;
    const globs = e.paths;
    return changedFiles.some((f) => globs.some((g) => matchesGlob(f, g)));
  });
}

/** Previous-head candidates from a PR's commit list (oldest first): the commits before the head, newest first. */
export function previousHeadCandidates(prCommits: readonly string[], headSha: string, max = 3): string[] {
  const i = prCommits.lastIndexOf(headSha);
  const before = i >= 0 ? prCommits.slice(0, i) : prCommits.filter((s) => s !== headSha);
  return before.slice(-max).reverse();
}

/** The first candidate, in BASELINE_ORDER, with a non-empty name list. */
export function pickBaseline(candidates: readonly BaselineCandidate[]): Baseline | null {
  for (const source of BASELINE_ORDER) {
    for (const c of candidates) {
      if (c.source !== source || c.sha === null || !c.names || c.names.length === 0) continue;
      return { source, sha: c.sha, confidence: BASELINE_CONFIDENCE[source], names: uniq(c.names) };
    }
  }
  return null;
}

export interface BuildExpectedInput {
  required: readonly string[];
  config: readonly ConfigExpectedEntry[];
  baseline: Baseline | null;
  /** `ci.ignore`: an ignored check is never expected, whatever its source. */
  ignore?: readonly IgnoreRule[];
  /** Further filter (the command's `--check` globs). Return false to drop a check. */
  consider?: (c: { name: string; workflow: string | null }) => boolean;
}

const overlaps = (a: ExpectedDef, name: string, workflow: string | null): boolean =>
  a.name === name && (a.workflow === null || workflow === null || a.workflow === workflow);

/** The expected definitions: required, then config, then baseline; a lower source never repeats a higher one. */
export function buildExpectedSet(i: BuildExpectedInput): ExpectedDef[] {
  const out: ExpectedDef[] = [];
  const add = (name: string, workflow: string | null, source: ExpectedSource): void => {
    if (out.some((d) => overlaps(d, name, workflow))) return;
    if (ignoreRuleFor({ name, workflow }, i.ignore ?? [])) return;
    if (i.consider && !i.consider({ name, workflow })) return;
    out.push({ name, workflow, source });
  };
  for (const n of i.required) add(n, null, 'required');
  for (const e of i.config) add(e.name, e.workflow ?? null, 'config');
  for (const n of i.baseline?.names ?? []) add(n, null, 'baseline');
  return out;
}

/** Whether a reported check satisfies an expected definition (same name; same workflow when the definition names one). */
export function satisfies(
  def: Pick<ExpectedDef, 'name' | 'workflow'>,
  check: Pick<Check, 'name' | 'workflow'>,
): boolean {
  return def.name === check.name && (def.workflow === null || def.workflow === check.workflow);
}

/**
 * Match the definitions against the reported checks: `reported` when a check satisfies it; otherwise
 * `absent` for a baseline check the caller has aged out (02 §11.3 `--expect-grace`), else `missing`.
 */
export function expectedState(
  defs: readonly ExpectedDef[],
  checks: readonly Pick<Check, 'name' | 'workflow'>[],
  agedOut: readonly string[] = [],
): ExpectedCheck[] {
  const aged = new Set(agedOut);
  return defs.map((d) => {
    const state = checks.some((c) => satisfies(d, c))
      ? 'reported'
      : d.source === 'baseline' && aged.has(d.name)
        ? 'absent'
        : 'missing';
    return { name: d.name, workflow: d.workflow, source: d.source, state };
  });
}

/**
 * The phase (02 §11.3), consistent with CiSummary (summary.ts):
 * - `registering`: nothing reported yet;
 * - `partial`: some checks reported, but an expected check is still missing (never green);
 * - `running`: everything expected has registered and something is pending;
 * - `settled`: done.
 */
export function expectedPhase(checks: readonly Check[], expected: readonly ExpectedCheck[]): CiPhase {
  return ciState(checks, expected.filter((e) => e.state === 'missing').length).phase;
}

/** Only a settled phase may end a wait green (`partial` is never terminal green). */
export const phaseAllowsGreen = (phase: CiPhase): boolean => phase === 'settled';
