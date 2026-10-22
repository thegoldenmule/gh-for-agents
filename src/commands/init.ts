// ghx init (01 §5): write a starter .github/ghx.json at the git toplevel.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CONFIG_PATH } from '../config/schema.ts';
import { buildStarter } from '../config/starter.ts';
import { defineCommand } from '../core/command.ts';
import { GhxError } from '../core/errors.ts';

export default defineCommand({
  name: ['init'],
  summary: 'Write a starter .github/ghx.json (components inferred from the workspace).',
  description:
    'Components come from --component (repeatable), else package.json workspaces / pnpm-workspace.yaml, else top-level directories. Refuses to overwrite without --force; --dry-run returns the config without writing.',
  kind: 'write',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({
    component: z.array(z.string().min(1)).optional().describe('Component name (repeatable); skips inference'),
    force: z.boolean().default(false).describe('Overwrite an existing config'),
  }),
  output: z.object({
    path: z.string(),
    written: z.boolean(),
    config: z.record(z.string(), z.unknown()),
    inferredFrom: z.enum(['flags', 'workspaces', 'directories']),
  }),
  examples: [{ argv: 'ghx init --dry-run' }, { argv: 'ghx init --component reactor --component codegen' }],
  async run(input, ctx) {
    const toplevel = await ctx.git.toplevel();
    if (!toplevel) {
      throw new GhxError('REPO_NOT_FOUND', 'ghx init must run inside a git checkout.', {
        hint: 'cd into the repository first.',
      });
    }
    const path = join(toplevel, CONFIG_PATH);
    if (existsSync(path) && !input.force && !ctx.dryRun) {
      throw new GhxError('CONFIG_EXISTS', `${path} already exists.`, { details: { path } });
    }
    let starter: Awaited<ReturnType<typeof buildStarter>>;
    try {
      starter = await buildStarter(toplevel, input.component ?? []);
    } catch (e) {
      if (e instanceof z.ZodError) {
        throw new GhxError('VALIDATION', 'The component names do not form a valid config.', {
          hint: 'Component names are lowercase scope tokens: [a-z0-9][a-z0-9-]*',
          details: { issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })) },
        });
      }
      throw e;
    }
    if (!ctx.dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(starter.config, null, 2)}\n`);
    }
    return { path, written: !ctx.dryRun, config: starter.config, inferredFrom: starter.inferredFrom };
  },
});
