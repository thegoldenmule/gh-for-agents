// Test-only (GHX_TEST_HOOKS=1): waits on the clock until the deadline or a signal. With --ignore-abort
// it never settles, which exercises the grace window.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { defineCommand } from '../../../../src/core/command.ts';

export default defineCommand({
  name: ['test', 'sleep'],
  summary: 'Test only: sleep until aborted.',
  kind: 'read',
  needs: { repo: 'none' },
  timeout: { defaultMs: 60_000, maxMs: 3_600_000 },
  input: z.strictObject({
    ms: z.number().int().min(0).default(3_600_000),
    ignoreAbort: z.boolean().default(false),
    readyFile: z.string().optional().describe('Written once the command is running (signal tests poll for it)'),
  }),
  output: z.object({ slept: z.number() }),
  async run(input, ctx) {
    if (input.readyFile) writeFileSync(input.readyFile, 'ready');
    if (input.ignoreAbort) await new Promise(() => {});
    await ctx.clock.sleep(input.ms, ctx.signal);
    return { slept: input.ms };
  },
});
