// Test-only (GHX_TEST_HOOKS=1): warns, then fails, so the error envelope must carry the warning in
// error.details.warnings (02 §1.3). `--fail` picks the failure: a GhxError without details, one with
// details (and a warning of its own), or a plain throw (INTERNAL).
import { z } from 'zod';
import { defineCommand } from '../../../../src/core/command.ts';
import { GhxError } from '../../../../src/core/errors.ts';

export default defineCommand({
  name: ['test', 'warn-fail'],
  summary: 'Test only: warn, then fail.',
  kind: 'read',
  needs: { repo: 'none' },
  input: z.strictObject({ fail: z.enum(['bare', 'details', 'internal']).default('bare') }),
  output: z.object({ ok: z.boolean() }),
  async run(input, ctx) {
    ctx.warn({ code: 'T_NORMALIZED', message: 'rewrote the input before failing' });
    if (input.fail === 'details') {
      throw new GhxError('VALIDATION', '1 input issue.', {
        details: {
          issues: [{ path: 'x', code: 'x.bad', message: 'bad' }],
          warnings: [{ code: 'T_OWN', message: 'carried by the error' }],
        },
      });
    }
    if (input.fail === 'internal') throw new Error('boom');
    throw new GhxError('GH_FAILED', 'gh failed.');
  },
});
