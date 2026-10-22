// Test-only (GHX_TEST_HOOKS=1): waits on the clock until the deadline or a signal. With --ignore-abort
// it never settles, which exercises the grace window.
import { z } from 'zod';
import { defineCommand } from '../../../../src/core/command.ts';

export default defineCommand({
  name: ['test', 'sleep'],
  summary: 'Test only: sleep until aborted.',
  kind: 'read',
  needs: { repo: 'none' },
  timeout: { defaultMs: 60_000, maxMs: 3_600_000 },
  input: z.strictObject({ ms: z.number().int().min(0).default(3_600_000), ignoreAbort: z.boolean().default(false) }),
  output: z.object({ slept: z.number() }),
  async run(input, ctx) {
    if (input.ignoreAbort) await new Promise(() => {});
    await ctx.clock.sleep(input.ms, ctx.signal);
    return { slept: input.ms };
  },
});
