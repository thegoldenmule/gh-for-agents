// gh/graphql (03 §3.4): a partial NOT_FOUND (HTTP 200, exit 1, data + errors) and duplicate rate
// headers, captured with the exact argv ghx's graphql() sends for a read query.
import { defineScenario } from '../scenario-api.ts';

export const PARTIAL_QUERY =
  '{repository(owner:"cli",name:"cli"){pullRequest(number:99999999){number}} rateLimit{remaining cost}}';
export const RATE_QUERY = '{rateLimit{remaining cost limit resetAt}}';

export default defineScenario({
  name: 'spike-graphql',
  description: 'GraphQL partial errors and duplicate X-Ratelimit-Resource headers',
  source: 'live:public',
  outDirs: ['graphql'],
  record(ctx) {
    ctx.capture('graphql', 'partial-not-found', ['api', 'graphql', '--include', '-f', `query=${PARTIAL_QUERY}`]);
    ctx.capture('graphql', 'rate-limit-headers-dup', ['api', 'graphql', '--include', '-f', `query=${RATE_QUERY}`]);
  },
});
