// gh/rest-checks (03 §3.1): a conditional REST tick. Each 200 is followed at once by the same GET
// with If-None-Match, which GitHub answers 304 (exit 1, headers on stdout, not counted).
import { defineScenario, type RecordContext } from '../scenario-api.ts';

const get = (path: string, etag?: string) => [
  'api',
  '--include',
  '-X',
  'GET',
  ...(etag ? ['-H', `If-None-Match: ${etag}`] : []),
  path,
];

function pair(ctx: RecordContext, name: string, path: string): void {
  const first = ctx.capture('rest-checks', `${name}-200`, get(path));
  const etag = /^etag:\s*(.+?)\s*$/im.exec(first.stdout)?.[1];
  if (etag) ctx.capture('rest-checks', `${name}-304`, get(path, etag));
}

export default defineScenario({
  name: 'etag',
  description: 'conditional REST polling: 200 with ETag, then 304 Not Modified',
  source: 'live:public',
  outDirs: ['rest-checks'],
  record(ctx) {
    const sha = ctx.gh(['api', 'repos/cli/cli/commits/trunk', '--jq', '.sha']).stdout.trim();
    pair(ctx, 'pulls', 'repos/cli/cli/pulls?per_page=1');
    pair(ctx, 'check-runs', `repos/cli/cli/commits/${sha}/check-runs?filter=latest&per_page=3`);
    pair(ctx, 'status', `repos/cli/cli/commits/${sha}/status`);
  },
});
