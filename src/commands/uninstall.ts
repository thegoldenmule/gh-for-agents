// ghx uninstall: undo ghx install. Removes only what ghx added, as its install manifest records it
// (src/install/owned.ts): its PreToolUse hook, the deny rules it added, the GHX_HOOK_MODE it set, the
// containers it created, the marked CLAUDE.md block, and a bin link into this checkout. The user's own
// identical rules and everything else stay. Backed up, atomic and idempotent, like install.
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../core/command.ts';
import { removeBlock } from '../install/claude-md.ts';
import { backupsOf, type FileChange, planBinUnlink, readOrNull, resolveTargets } from '../install/files.ts';
import { manifestPath, ownedSettings, readManifest, restored, serializeManifest } from '../install/owned.ts';
import { finish, InstallOutput } from '../install/report.ts';
import {
  inspectSettings,
  keepsFormatting,
  parseSettings,
  serializeSettings,
  uninstallSettings,
} from '../install/settings.ts';
import { reformattedWarning, styleKeepsBytes } from '../install/text.ts';

/** A legacy install's file: removed when uninstall empties it, unless a ghx backup shows it existed that way. */
function legacyRemoved(path: string, content: string, empty: string): boolean {
  return content === empty && !backupsOf(path).some((b) => readOrNull(b) === content);
}

export default defineCommand({
  name: ['uninstall'],
  summary: 'Remove what ghx install added to Claude Code settings and CLAUDE.md (try --dry-run).',
  description:
    'Removes only what ghx install added, as its install record (kept beside its backups in the user config ' +
    'dir) shows: the ghx PreToolUse hook, the deny rules it added (never your identical ones), the ' +
    'GHX_HOOK_MODE it set (restoring any earlier value), containers it created once empty, the marked ' +
    'CLAUDE.md block, and the <dir>/ghx link install made (found from the record, or given with --bin-dir). Every other setting stays. A file ' +
    'still exactly as ghx last wrote it gets its original bytes back from the backup. An ' +
    'install from before the record is judged from its <file>.bak-ghx-* backups. Backs up each changed ' +
    'file; a file ghx created and leaves empty is removed. --dry-run returns unified diffs and writes nothing.',
  kind: 'write',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({
    scope: z
      .enum(['user', 'project'])
      .default('user')
      .describe('user (~/.claude) or project (repo .claude/settings.local.json)'),
    binDir: z
      .string()
      .min(1)
      .optional()
      .describe('Remove <dir>/ghx if it links to ghx (default: the link ghx install recorded, if any)'),
    snippet: z.boolean().default(true).describe('Remove the CLAUDE.md block; --no-snippet leaves it'),
  }),
  output: InstallOutput,
  brief: ['scope', 'dryRun', 'changed', 'files.path', 'files.action', 'binLink.action', 'next'],
  examples: [
    { argv: 'ghx uninstall --dry-run', note: 'Show the diffs first' },
    { argv: 'ghx uninstall --bin-dir ~/.local/bin' },
  ],
  async run(input, ctx) {
    const targets = await resolveTargets(input.scope, ctx.env, ctx.git);
    const changes: FileChange[] = [];

    const manifest = readManifest(targets);
    const sBefore = readOrNull(targets.settings);
    const parsed = parseSettings(sBefore, targets.settings);
    const found = inspectSettings(parsed);
    const owned = ownedSettings(targets, manifest, parsed);
    const kept = uninstallSettings(parsed, owned);
    const backupDir = join(targets.stateDir, 'backups');
    let sAfter = sBefore;
    const sRestored = restored(manifest?.settings?.restore, sBefore, backupDir);
    if (sRestored) {
      // Untouched since ghx wrote it: put the original bytes back (or remove the file ghx created).
      sAfter = sRestored.content;
    } else if (JSON.stringify(kept) !== JSON.stringify(parsed)) {
      const text = serializeSettings(kept, sBefore);
      if (sBefore !== null && !keepsFormatting(sBefore, parsed)) ctx.warn(reformattedWarning(targets.settings, false));
      const empty = Object.keys(kept).length === 0;
      const remove = owned.created ?? legacyRemoved(targets.settings, text, serializeSettings({}, sBefore));
      sAfter = empty && remove ? null : text;
    }
    changes.push({ path: targets.settings, kind: 'settings', before: sBefore, after: sAfter });

    if (input.snippet) {
      const mBefore = readOrNull(targets.claudeMd);
      const stripped = mBefore === null ? null : removeBlock(mBefore, targets.claudeMd);
      let mAfter = mBefore;
      const mRestored = restored(manifest?.claudeMd?.restore, mBefore, backupDir);
      if (mRestored) {
        mAfter = mRestored.content;
      } else if (stripped !== null && stripped !== mBefore) {
        const created = manifest?.claudeMd?.created ?? legacyRemoved(targets.claudeMd, stripped, '');
        mAfter = stripped === '' && created ? null : stripped;
        if (mBefore !== null && !styleKeepsBytes(mBefore)) ctx.warn(reformattedWarning(targets.claudeMd, false));
      }
      changes.push({ path: targets.claudeMd, kind: 'claude-md', before: mBefore, after: mAfter });
    }
    // --no-snippet keeps the block, so the record keeps its CLAUDE.md entry for a later uninstall.
    const keptRecord = !input.snippet && manifest?.claudeMd ? { ...manifest, settings: null, binLink: null } : null;

    const recorded = manifest?.binLink ?? null;
    const binDir = input.binDir ? resolve(ctx.cwd, input.binDir) : recorded ? dirname(recorded.path) : null;
    const binLink = binDir ? planBinUnlink(binDir, ctx.env, recorded?.target) : null;
    if (binLink?.action === 'unchanged') {
      ctx.warn({
        code: 'INSTALL_BIN_FOREIGN',
        message: `${binLink.path} is not a link to this checkout's bin/ghx.js; left it alone.`,
      });
    }
    return finish(
      {
        scope: targets.scope,
        backupDir,
        changes,
        hookCommand: found.hookCommands[0] ?? null,
        denyRules: found.denyPresent,
        binLink,
        manifest: manifest
          ? { path: manifestPath(targets), content: keptRecord ? serializeManifest(keptRecord) : null }
          : undefined,
      },
      { dryRun: ctx.dryRun, clock: ctx.clock, next: ['Start a new Claude Code session so it drops the hook.'] },
    );
  },
});
