import { z } from 'zod';
import { defineCommand } from '../core/command.ts';
import { RUNTIME, type Runtime } from '../util/runtime.ts';
import { VERSION } from '../version.ts';

/** `ghx version`'s document for a runtime (exported for tests of the standalone binary's shape). */
export function versionInfo(rt: Runtime = RUNTIME) {
  return {
    name: 'ghx' as const,
    version: VERSION,
    // Bun reports a Node.js version it is compatible with; that is not a Node.js ghx runs on.
    node: rt.name === 'node' ? rt.version : null,
    platform: `${process.platform}-${process.arch}`,
    runtime: { name: rt.name, version: rt.version, standalone: rt.compiled },
  };
}

export default defineCommand({
  name: ['version'],
  summary: 'Print the ghx version, runtime and platform (no gh calls).',
  kind: 'read',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({}),
  output: z.object({
    name: z.literal('ghx'),
    version: z.string(),
    node: z.string().nullable().describe('The Node.js version ghx runs on; null for the standalone binary'),
    platform: z.string(),
    runtime: z.object({
      name: z.enum(['node', 'bun']).describe('node (npm install or checkout) or bun (the standalone binary)'),
      version: z.string(),
      standalone: z.boolean().describe('Whether this is the standalone binary from GitHub Releases'),
    }),
  }),
  examples: [{ argv: 'ghx version' }],
  async run() {
    return versionInfo();
  },
});
