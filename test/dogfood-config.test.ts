// This repo's own .github/ghx.json (03 §7.3): it parses through the production loader, every repo file
// maps to a component, the CI keys name real jobs and steps of ci.yml, and a sample PR validates
// against it (and an unknown component does not).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { parseConfigText } from '../src/config/load.ts';
import { CONFIG_PATH } from '../src/config/schema.ts';
import { offlineIssues } from '../src/pr/create/plan.ts';
import { matchesGlob } from '../src/util/glob.ts';

const ROOT = join(import.meta.dirname, '..');
const PATH = join(ROOT, CONFIG_PATH);
const config = parseConfigText(readFileSync(PATH, 'utf8'), { kind: 'local', path: PATH });

/** Untracked or generated trees (.gitignore, the VCS and local tool state). */
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.ghx-artifacts', '.git', '.claude', '.DS_Store']);

function repoFiles(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const abs = join(dir, e.name);
    return e.isDirectory() ? repoFiles(abs) : [relative(ROOT, abs).split('\\').join('/')];
  });
}

test('the dogfood config parses through the production loader with merge commits', () => {
  assert.equal(config.version, 1);
  assert.equal(config.merge.method, 'merge');
  for (const c of [
    'cli',
    'core',
    'config',
    'gh',
    'ci',
    'pr',
    'policy',
    'feedback',
    'render',
    'hook',
    'docs',
    'build',
  ]) {
    assert.ok(config.components[c]?.paths?.length, `component ${c} with paths`);
  }
});

test('every file in the repo maps to at least one component', () => {
  const globs = Object.values(config.components).flatMap((c) => c.paths ?? []);
  const unmapped = repoFiles().filter((f) => !globs.some((g) => matchesGlob(f, g)));
  assert.deepEqual(unmapped, []);
});

test('ci.expected and ci.keySteps name real jobs and steps of .github/workflows/ci.yml', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const workflow = /^name:\s*(\S+)/m.exec(yml)?.[1];
  const job = /^ {2}(\w[\w-]*):\n(?: {4}.*\n)*? {6}matrix: \{ os: \[([^\]]+)\] \}/m.exec(yml);
  assert.ok(job, 'the check job and its os matrix');
  const names = (job[2] ?? '').split(',').map((os) => `${job[1]} (${os.trim()})`);
  assert.deepEqual(
    (config.ci.expected ?? []).map((e) => [e.name, e.workflow]),
    names.map((n) => [n, workflow]),
  );
  for (const step of config.ci.keySteps ?? []) {
    const m = new RegExp(`- name: ${step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(\\s+if:)?`).exec(yml);
    assert.ok(m, `step "${step}" exists`);
    // A key step skipped on any matrix leg would read as a misleading green on every run.
    assert.equal(m[1], undefined, `step "${step}" has no if:`);
  }
});

test('a sample PR validates against the dogfood components; an unknown component does not', () => {
  const pr = {
    title: 'fix(ci): count a resumed wait once',
    description: 'A resumed wait was counted twice in the summary.',
    testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
    risk: 'low',
    components: ['ci'],
    revertPolicy: 'revert-safe',
    base: 'main',
    head: 'fix/resumed-wait-count',
  };
  const ok = offlineIssues(pr, config);
  assert.ok(ok.input, JSON.stringify(ok.issues));
  assert.deepEqual(ok.issues, []);
  const bad = offlineIssues({ ...pr, title: 'fix(reactor): x', components: ['reactor'] }, config);
  assert.deepEqual(bad.issues.map((i) => i.path).sort(), ['components[0]', 'title']);
});
