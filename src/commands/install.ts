// ghx install: put the steering kit (docs/agents/hooks.md, claude-md-snippet.md) into Claude Code's
// settings without an LLM in the loop. Merges the deny rules and one ghx PreToolUse hook into
// settings.json, adds the marked CLAUDE.md block, and optionally links ghx onto PATH. Idempotent;
// every changed file is backed up first and written atomically.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../core/command.ts';
import { installBlock } from '../install/claude-md.ts';
import {
  type FileChange,
  hookCommand,
  planBinLink,
  readOrNull,
  resolveTargets,
  SNIPPET_PATH,
} from '../install/files.ts';
import { finish, InstallOutput } from '../install/report.ts';
import { GHX_DENY_RULES, installSettings, parseSettings, serializeSettings } from '../install/settings.ts';

export default defineCommand({
  name: ['install'],
  summary: 'Install the Claude Code hook, gh write deny rules and CLAUDE.md block (try --dry-run).',
  description:
    'User scope edits $CLAUDE_CONFIG_DIR (else ~/.claude)/settings.json and CLAUDE.md; project scope edits ' +
    '.claude/settings.json and CLAUDE.md at the git toplevel. Keeps every other setting, backs up each changed ' +
    'file to <file>.bak-ghx-<time>, and writes atomically. The hook runs this checkout by absolute path. ' +
    'Re-running updates in place; --dry-run returns unified diffs and writes nothing. Undo: ghx uninstall.',
  kind: 'write',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({
    scope: z.enum(['user', 'project']).default('user').describe('user (~/.claude) or project (repo .claude/)'),
    deny: z.boolean().default(true).describe('Merge the gh write deny rules; --no-deny skips them'),
    hook: z.boolean().default(true).describe('Register the PreToolUse hook; --no-hook skips it'),
    snippet: z.boolean().default(true).describe('Add the CLAUDE.md block; --no-snippet skips it'),
    binDir: z.string().min(1).optional().describe('Also symlink <dir>/ghx to bin/ghx.js'),
    hookMode: z
      .enum(['ask', 'deny'])
      .optional()
      .describe('deny sets env.GHX_HOOK_MODE=deny; ask removes it (the default mode)'),
  }),
  output: InstallOutput,
  examples: [
    { argv: 'ghx install --dry-run', note: 'Show the diffs first' },
    { argv: 'ghx install --bin-dir ~/.local/bin' },
    { argv: 'ghx install --scope project --no-snippet' },
  ],
  async run(input, ctx) {
    const targets = await resolveTargets(input.scope, ctx.env, ctx.git);
    const command = input.hook ? hookCommand() : null;
    const changes: FileChange[] = [];

    // Plan and validate everything before writing anything.
    if (input.deny || input.hook || input.hookMode) {
      const before = readOrNull(targets.settings);
      const parsed = parseSettings(before, targets.settings);
      const next = installSettings(parsed, { deny: input.deny, hookCommand: command, hookMode: input.hookMode });
      const same = JSON.stringify(next) === JSON.stringify(parsed);
      changes.push({
        path: targets.settings,
        kind: 'settings',
        before,
        after: same ? before : serializeSettings(next, before),
      });
    }
    if (input.snippet) {
      const before = readOrNull(targets.claudeMd);
      const snippet = readFileSync(SNIPPET_PATH, 'utf8');
      changes.push({
        path: targets.claudeMd,
        kind: 'claude-md',
        before,
        after: installBlock(before, snippet, targets.claudeMd),
      });
    }
    const binLink = input.binDir ? planBinLink(resolve(ctx.cwd, input.binDir), ctx.env) : null;

    if (input.scope === 'project' && command) {
      ctx.warn({
        code: 'INSTALL_PROJECT_ABSOLUTE_PATHS',
        message: `The hook command in ${targets.settings} holds this machine's absolute paths; don't commit it as-is for other contributors.`,
      });
    }
    const next = ['Start a new Claude Code session so it loads the settings.', 'Check the install: ghx doctor'];
    if (binLink && !binLink.onPath) next.push(`Add ${resolve(binLink.path, '..')} to PATH to run ghx by name.`);
    return finish(
      { scope: targets.scope, changes, hookCommand: command, denyRules: input.deny ? GHX_DENY_RULES : [], binLink },
      { dryRun: ctx.dryRun, clock: ctx.clock, next },
    );
  },
});
