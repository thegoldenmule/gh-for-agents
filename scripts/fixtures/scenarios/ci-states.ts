// gh/ci-snapshot/* (03 §6.2): the CI subset of Q1 (src/ci/snapshot.ts), captured with the exact argv
// fetchCiSnapshot sends. The sandbox is deferred (03 Q2), so the live states come from public PRs and
// the rest are synthetic edits of the live `pass` capture (same headers, edited JSON body).
//
//   pass            cli/cli#14770        merged, every check green
//   fail            cli/cli#14630        govulncheck failed
//   status-context  nodejs/node#66900    Jenkins commit statuses (StatusContext) beside Actions runs
//   pending         an open cli/cli PR whose rollup is PENDING at record time (synthetic fallback)
//   no-checks, rerun-duplicates, ignored-noise, oid-mismatch: synthetic, derived from `pass`

import { CI_SNAPSHOT_QUERY } from '../../../src/ci/snapshot.ts';
import { parseIncludeOutput } from '../../../src/gh/api.ts';
import { buildGraphqlArgs } from '../../../src/gh/graphql.ts';
import { type Captured, defineScenario, type RecordContext } from '../scenario-api.ts';

const argvFor = (owner: string, name: string, number: number): string[] =>
  buildGraphqlArgs(CI_SNAPSHOT_QUERY, { owner, name, number, after: null }).args;

type Json = Record<string, any>;

function bodyOf(c: Captured): Json {
  return JSON.parse(parseIncludeOutput(c.stdout).body) as Json;
}

/** Re-emit a capture's headers with a new JSON body. */
function withBody(c: Captured, body: Json): string {
  const p = parseIncludeOutput(c.stdout);
  const head = c.stdout.slice(0, c.stdout.length - p.body.length);
  return `${head}${JSON.stringify(body)}`;
}

const commitOf = (b: Json): Json => b.data.repository.pullRequest.commits.nodes[0].commit;

function synthetic(ctx: RecordContext, dir: string, file: string, from: Captured, body: Json, note: string): void {
  ctx.write(`ci-snapshot/${dir}`, file, {
    argv: from.argv,
    exitCode: 0,
    stdout: withBody(from, body),
    stderr: '',
    meta: { source: 'synthetic', recordedAt: ctx.recordedAt, ghVersion: ctx.ghVersion, note },
  });
}

export default defineScenario({
  name: 'ci-states',
  description:
    'CI rollup snapshots (src/ci/snapshot.ts): pass, fail, pending, status contexts, and synthetic edge cases',
  source: 'live:public',
  outDirs: [
    'ci-snapshot/pass',
    'ci-snapshot/fail',
    'ci-snapshot/pending',
    'ci-snapshot/status-context',
    'ci-snapshot/no-checks',
    'ci-snapshot/rerun-duplicates',
    'ci-snapshot/ignored-noise',
    'ci-snapshot/oid-mismatch',
  ],
  record(ctx) {
    const pass = ctx.capture('ci-snapshot/pass', '001-rollup', argvFor('cli', 'cli', 14770), {
      note: 'cli/cli#14770: merged, all checks green',
    });
    ctx.capture('ci-snapshot/fail', '001-rollup', argvFor('cli', 'cli', 14630), {
      note: 'cli/cli#14630: govulncheck failed',
    });
    ctx.capture('ci-snapshot/status-context', '001-rollup', argvFor('nodejs', 'node', 66900), {
      note: 'nodejs/node#66900: Jenkins StatusContexts beside Actions check runs',
    });

    // pending: the first open PR whose rollup is PENDING right now.
    const open = ctx.gh(['pr', 'list', '-R', 'cli/cli', '--state', 'open', '--limit', '15', '--json', 'number']);
    let pendingDone = false;
    for (const { number } of JSON.parse(open.stdout || '[]') as { number: number }[]) {
      const probe = ctx.gh(argvFor('cli', 'cli', number));
      const state = (() => {
        try {
          const nodes = commitOf(bodyOf(probe)).statusCheckRollup?.contexts.nodes ?? [];
          return nodes.some((n: Json) => n.status !== undefined && n.status !== 'COMPLETED');
        } catch {
          return false;
        }
      })();
      if (state) {
        ctx.capture('ci-snapshot/pending', '001-rollup', argvFor('cli', 'cli', number), {
          note: `cli/cli#${number}: checks in progress at record time`,
        });
        pendingDone = true;
        break;
      }
    }
    const base = bodyOf(pass);
    const clone = (): Json => structuredClone(base);
    if (!pendingDone) {
      const b = clone();
      const nodes = commitOf(b).statusCheckRollup.contexts.nodes as Json[];
      for (const n of nodes.slice(0, 3)) {
        n.status = 'IN_PROGRESS';
        n.conclusion = null;
        n.completedAt = null;
      }
      synthetic(ctx, 'pending', '001-rollup', pass, b, 'cli/cli#14770 with three checks set back to IN_PROGRESS');
    }

    {
      const b = clone();
      commitOf(b).statusCheckRollup = null;
      synthetic(
        ctx,
        'no-checks',
        '001-rollup',
        pass,
        b,
        'cli/cli#14770 with statusCheckRollup null (nothing registered)',
      );
    }
    {
      const b = clone();
      const nodes = commitOf(b).statusCheckRollup.contexts.nodes as Json[];
      const tmpl = nodes.find((n) => n.__typename === 'CheckRun' && n.checkSuite?.workflowRun) as Json;
      const watch = (id: number, conclusion: string): Json => ({
        ...structuredClone(tmpl),
        databaseId: id,
        name: 'CI duration watch',
        conclusion,
        detailsUrl: `https://github.com/cli/cli/actions/runs/${tmpl.checkSuite.workflowRun.databaseId}/job/${id}`,
      });
      // Attempt 1 failed, attempt 2 (re-run, larger job id) passed: one row must remain, the pass.
      nodes.push(watch(tmpl.databaseId + 1000, 'FAILURE'), watch(tmpl.databaseId + 2000, 'SUCCESS'));
      synthetic(
        ctx,
        'rerun-duplicates',
        '001-rollup',
        pass,
        b,
        'cli/cli#14770 plus a re-run CI duration watch job (failed, then passed)',
      );
    }
    {
      const b = clone();
      const nodes = commitOf(b).statusCheckRollup.contexts.nodes as Json[];
      const tmpl = nodes.find((n) => n.__typename === 'CheckRun' && n.checkSuite?.workflowRun) as Json;
      nodes.push({
        ...structuredClone(tmpl),
        databaseId: tmpl.databaseId + 3000,
        name: 'notify-discord',
        conclusion: 'SKIPPED',
      });
      synthetic(ctx, 'ignored-noise', '001-rollup', pass, b, 'cli/cli#14770 plus a skipped notify-discord job');
    }
    {
      const b = clone();
      commitOf(b).oid = '0000000000000000000000000000000000000001';
      const note = 'cli/cli#14770 with the rollup commit oid differing from headRefOid';
      synthetic(ctx, 'oid-mismatch', '001-rollup', pass, b, `${note} (first query)`);
      synthetic(ctx, 'oid-mismatch', '002-rollup-requery', pass, b, `${note} (the one re-query)`);
    }
  },
});
