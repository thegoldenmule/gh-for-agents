// Fixture hygiene (03 §2 M1.16): every fixture parses, carries meta.source (inline, or a directory
// _meta.json for non-JSON files), contains no token or email address, and is referenced by a test.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { EMAIL, TOKEN } from '../scripts/fixtures/redact.ts';

const ROOT = join(import.meta.dirname, '..');
const FIX = join(ROOT, 'test', 'fixtures');
const SOURCES = new Set(['live:sandbox', 'live:public', 'synthetic', 'corpus-shape']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(FIX).filter((f) => !f.startsWith(join(FIX, 'bin')) && basename(f) !== '_meta.json');
const testSources = [
  ...walk(join(ROOT, 'test')).filter((f) => f.endsWith('.ts') && !f.startsWith(FIX)),
  ...walk(join(ROOT, 'scripts')),
]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** `ref` occurs in a test source as a whole token: not inside a longer name or path segment. */
function isReferenced(ref: string, source: string = testSources): boolean {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`, 'm').test(source);
}

function dirMeta(
  file: string,
): { meta?: { source?: string }; files?: Record<string, { source?: string }> } | undefined {
  const m = join(dirname(file), '_meta.json');
  return existsSync(m) ? JSON.parse(readFileSync(m, 'utf8')) : undefined;
}

test('a fixture reference is a whole token, not a substring of another name', () => {
  for (const src of ["body('crlf.md')", 'bodies/crlf.md', "'crlf'", 'FakeGh.fromScenario("crlf")', 'crlf']) {
    assert.ok(isReferenced('crlf', src), src);
  }
  for (const src of ["'no-crlf.md'", "'crlfish'", 'x.crlf', 'bodies/crlf-v2.md', 'my_crlf']) {
    assert.ok(!isReferenced('crlf', src), src);
  }
  assert.ok(isReferenced('ci-snapshot/pending', "fromScenario('ci-snapshot/pending')"));
  assert.ok(!isReferenced('ci-snapshot/pending', "fromScenario('ci-snapshot/pending-long')"));
});

test('there are fixtures', () => {
  assert.ok(files.length > 20);
});

for (const file of files) {
  const rel = relative(FIX, file);
  test(`fixture ${rel}`, () => {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, TOKEN, 'contains a token');
    const emails = (text.match(EMAIL) ?? []).filter(
      (e) => e !== 'user@example.invalid' && !/^noreply@(anthropic|github)\.com$/.test(e),
    );
    assert.deepEqual(emails, [], 'contains an email address');

    const isGhFixture = rel.startsWith(`gh${'/'}`) && file.endsWith('.json');
    if (isGhFixture) {
      const f = JSON.parse(text) as { argv?: unknown; meta?: { source?: string } };
      assert.ok(Array.isArray(f.argv), 'gh fixtures have argv');
      assert.ok(SOURCES.has(f.meta?.source ?? ''), `meta.source is one of ${[...SOURCES].join(', ')}`);
    } else {
      // invalid-json*.json are unparsable on purpose (the parse-error tests).
      if (file.endsWith('.json') && !basename(file).startsWith('invalid-json')) JSON.parse(text);
      const isLogOfFixture = file.endsWith('.log') && existsSync(file.replace(/\.log$/, '.json'));
      if (!isLogOfFixture) {
        const dm = dirMeta(file);
        const src = dm?.files?.[basename(file)]?.source ?? dm?.meta?.source;
        assert.ok(SOURCES.has(src ?? ''), `${rel}: a directory _meta.json gives meta.source`);
      }
    }

    // Referenced by at least one test: by file name or stem, or (for gh scenarios) by scenario
    // directory, as a whole token. `crlf` matches 'crlf', "bodies/crlf.md" or `crlf.md`, but not
    // `no-crlf` or `crlfish`, so one fixture's name cannot vouch for another's.
    const stem = basename(file).replace(/\.[^.]+$/, '');
    const scenario = rel.startsWith(`gh${'/'}`) ? dirname(rel).slice(3) : undefined;
    const refs = [stem, basename(file), ...(scenario ? [scenario] : [])];
    if (file.endsWith('.log')) refs.push(basename(dirname(file)));
    assert.ok(
      refs.some((r) => isReferenced(r)),
      `${rel} is not referenced by any test`,
    );
  });
}
