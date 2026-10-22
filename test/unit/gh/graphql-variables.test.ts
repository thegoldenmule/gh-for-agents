// GitHub rejects an operation that declares a variable it never uses (GraphQL spec "All Variables Used"),
// and recorded fixtures cannot catch it. Every generated read query must use each variable it declares.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CI_SNAPSHOT_QUERY } from '../../../src/ci/snapshot.ts';
import { FALLBACK_BRANCH_QUERY, FALLBACK_PR_QUERY, SUITES_QUERY } from '../../../src/ci/wait/poller.ts';
import { buildOpenOnHeadQuery, buildPreflightQuery } from '../../../src/pr/create/preflight.ts';
import { PR_COMMITS_QUERY } from '../../../src/pr/snapshot/facts.ts';
import { MERGEABLE_QUERY } from '../../../src/pr/snapshot/mergeable.ts';
import { connectionPageQuery, Q1_QUERY, THREAD_COMMENTS_QUERY } from '../../../src/pr/snapshot/query.ts';
import { q2Query } from '../../../src/pr/snapshot/stack.ts';

const REPO = { host: 'github.com', owner: 'o', name: 'r' };

/** Declared variables that the body never references. */
export function unusedVariables(query: string): string[] {
  const header = /^\s*(?:query|mutation)\s*\(([^)]*)\)/.exec(query);
  if (!header) return [];
  const declared = [...(header[1] ?? '').matchAll(/\$(\w+)\s*:/g)].map((m) => m[1] as string);
  const body = query.slice(header[0].length);
  return declared.filter((v) => !new RegExp(`\\$${v}\\b`).test(body));
}

test('unusedVariables finds a declared-but-unused variable', () => {
  assert.deepEqual(unusedVariables('query($a:String!,$b:String!){x(a:$a)}'), ['b']);
  assert.deepEqual(unusedVariables('query($a:String!){x(a:$a)}'), []);
});

test('Q2 declares $base/$head only with the parent/children lookups, and sends only what it declares', () => {
  for (const wantParent of [false, true]) {
    for (const wantChildren of [false, true]) {
      for (const conditionRefs of [[], ['#12', 'other/lib#3']]) {
        const plan = q2Query({ repo: REPO, wantParent, wantChildren, conditionRefs });
        const label = JSON.stringify({ wantParent, wantChildren, conditionRefs });
        assert.deepEqual(unusedVariables(plan.query), [], label);
        const declared = [...plan.query.matchAll(/\$(\w+):/g)].map((m) => m[1]);
        assert.deepEqual(declared, [...plan.variables], label);
      }
    }
  }
});

test('every other generated read query uses each variable it declares', () => {
  const queries: Record<string, string> = {
    CI_SNAPSHOT_QUERY,
    FALLBACK_PR_QUERY,
    FALLBACK_BRANCH_QUERY,
    SUITES_QUERY,
    PR_COMMITS_QUERY,
    MERGEABLE_QUERY,
    Q1_QUERY,
    THREAD_COMMENTS_QUERY,
    comments: connectionPageQuery('comments'),
    reviews: connectionPageQuery('reviews'),
    reviewThreads: connectionPageQuery('reviewThreads'),
    timelineItems: connectionPageQuery('timelineItems'),
    preflight: buildPreflightQuery([]),
    openOnHead: buildOpenOnHeadQuery(),
  };
  for (const [name, q] of Object.entries(queries)) assert.deepEqual(unusedVariables(q), [], name);
});
