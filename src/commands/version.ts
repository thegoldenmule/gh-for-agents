import { z } from 'zod';
import { defineCommand } from '../core/command.ts';
import { VERSION } from '../version.ts';

export default defineCommand({
  name: ['version'],
  summary: 'Print the ghx version, Node version and platform (no gh calls).',
  kind: 'read',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({}),
  output: z.object({
    name: z.literal('ghx'),
    version: z.string(),
    node: z.string(),
    platform: z.string(),
  }),
  examples: [{ argv: 'ghx version' }],
  async run() {
    return {
      name: 'ghx' as const,
      version: VERSION,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
    };
  },
});
