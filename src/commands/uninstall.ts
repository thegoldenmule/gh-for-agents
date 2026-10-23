// ghx uninstall: undo ghx install. Removes only what ghx adds (its PreToolUse hook, the exact deny
// rule strings, a recognised env.GHX_HOOK_MODE, the marked CLAUDE.md block, and a bin link into this
// checkout); everything else in the files stays. Backed up, atomic and idempotent, like install.
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../core/command.ts';
import { removeBlock } from '../install/claude-md.ts';
import { backupsOf, type FileChange, planBinUnlink, readOrNull, resolveTargets } from '../install/files.ts';
import { finish, InstallOutput } from '../install/report.ts';
import { inspectSettings, parseSettings, serializeSettings, uninstallSettings } from '../install/settings.ts';

/**
 * Of the candidate contents, the one a ghx backup of `path` holds byte for byte; else the last. This
 * is how uninstall tells a container the user had (an empty "PreToolUse": []) from one ghx created.
 */
function pickByBackup(path: string, candidates: readonly string[]): string {
  return candidates.find((c) => hasBackup(path, c)) ?? (candidates[candidates.length - 1] as string);
}

function hasBackup(path: string, content: string): boolean {
  return backupsOf(path).some((b) => readOrNull(b) === content);
}

/** A file uninstall leaves with nothing in it is removed, unless a backup shows it existed that way. */
function orRemoved(path: string, content: string, empty: string): string | null {
  return content === empty && !hasBackup(path, content) ? null : content;
}

export default defineCommand({
  name: ['uninstall'],
  summary: 'Remove what ghx install added to Claude Code settings and CLAUDE.md (try --dry-run).',
  description:
    'Removes only the ghx PreToolUse hook, the exact ghx deny rules, a GHX_HOOK_MODE of ask|deny|off, the ' +
    'marked CLAUDE.md block, and with --bin-dir a ghx link into this checkout. Every other setting stays. ' +
    'Containers it empties are dropped unless a ghx backup shows they existed. Backs up each changed file; ' +
    'a file left empty is removed. --dry-run returns unified diffs and writes nothing.',
  kind: 'write',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({
    scope: z.enum(['user', 'project']).default('user').describe('user (~/.claude) or project (repo .claude/)'),
    binDir: z.string().min(1).optional().describe('Also remove <dir>/ghx if it links to this checkout'),
  }),
  output: InstallOutput,
  examples: [
    { argv: 'ghx uninstall --dry-run', note: 'Show the diffs first' },
    { argv: 'ghx uninstall --bin-dir ~/.local/bin' },
  ],
  async run(input, ctx) {
    const targets = await resolveTargets(input.scope, ctx.env, ctx.git);
    const changes: FileChange[] = [];

    const sBefore = readOrNull(targets.settings);
    const parsed = parseSettings(sBefore, targets.settings);
    const found = inspectSettings(parsed);
    const kept = uninstallSettings(parsed, false);
    let sAfter = sBefore;
    if (JSON.stringify(kept) !== JSON.stringify(parsed)) {
      const pruned = uninstallSettings(parsed, true);
      const text = pickByBackup(targets.settings, [
        serializeSettings(kept, sBefore),
        serializeSettings(pruned, sBefore),
      ]);
      sAfter = orRemoved(targets.settings, text, serializeSettings({}, sBefore));
    }
    changes.push({ path: targets.settings, kind: 'settings', before: sBefore, after: sAfter });

    const mBefore = readOrNull(targets.claudeMd);
    const stripped = mBefore === null ? null : removeBlock(mBefore, targets.claudeMd);
    const mAfter = stripped === null || stripped === mBefore ? mBefore : orRemoved(targets.claudeMd, stripped, '');
    changes.push({ path: targets.claudeMd, kind: 'claude-md', before: mBefore, after: mAfter });

    const binLink = input.binDir ? planBinUnlink(resolve(ctx.cwd, input.binDir), ctx.env) : null;
    if (binLink?.action === 'unchanged') {
      ctx.warn({
        code: 'INSTALL_BIN_FOREIGN',
        message: `${binLink.path} is not a link to this checkout's bin/ghx.js; left it alone.`,
      });
    }
    return finish(
      {
        scope: targets.scope,
        changes,
        hookCommand: found.hookCommands[0] ?? null,
        denyRules: found.denyPresent,
        binLink,
      },
      { dryRun: ctx.dryRun, clock: ctx.clock, next: ['Start a new Claude Code session so it drops the hook.'] },
    );
  },
});
