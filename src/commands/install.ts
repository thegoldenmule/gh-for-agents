// ghx install: put the steering kit (docs/agents/hooks.md, claude-md-snippet.md) into Claude Code's
// settings without an LLM in the loop. Merges one ghx PreToolUse hook into the settings (plus, at
// project scope, the gh write deny rules), adds the marked CLAUDE.md block, and optionally links ghx
// onto PATH. Idempotent; every changed file is backed up first and written atomically.
// User scope adds no deny rules (04 "enforcement scope"): they can't be conditional, and the hook
// enforces only in repos with .github/ghx.json. A user-scope re-install removes ones ghx added earlier.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../core/command.ts';
import { GhxError } from '../core/errors.ts';
import { installBlock, removeBlock } from '../install/claude-md.ts';
import {
  backupsOf,
  type FileChange,
  hookCommand,
  planBinLink,
  readOrNull,
  resolveTargets,
  SNIPPET_PATH,
} from '../install/files.ts';
import { type Manifest, manifestPath, ownedSettings, readManifest, serializeManifest } from '../install/owned.ts';
import { finish, InstallOutput } from '../install/report.ts';
import {
  GHX_DENY_RULES,
  installSettings,
  parseSettings,
  recordAdded,
  removeDenyRules,
  serializeSettings,
} from '../install/settings.ts';

export default defineCommand({
  name: ['install'],
  summary: 'Install the Claude Code hook and CLAUDE.md block, plus deny rules at project scope (try --dry-run).',
  description:
    'User scope edits $CLAUDE_CONFIG_DIR (else ~/.claude)/settings.json and CLAUDE.md, adding the hook and ' +
    'the block but no deny rules: deny rules cannot be conditional, and the hook enforces only in repos with ' +
    '.github/ghx.json. A user-scope re-install removes deny rules an earlier ghx install added (warning ' +
    'INSTALL_DENY_REMOVED) and never the ones you added. Project scope edits .claude/settings.local.json ' +
    '(per machine, uncommitted) and CLAUDE.md at the git toplevel, and also merges the gh write deny rules ' +
    '(--no-deny skips them). Warns ' +
    'SETTINGS_LOCAL_NOT_IGNORED when git would not ignore that file. Keeps every other setting, backs up each changed ' +
    'file to <config dir>/ghx-install/<scope>-<hash>/backups/<name>.bak-ghx-<time> (never into the repo; ' +
    'files[].backup gives each path) beside the record of what it added, and writes atomically. The hook runs this checkout by absolute path. ' +
    'Re-running updates in place; --dry-run returns unified diffs and writes nothing. Undo: ghx uninstall.',
  kind: 'write',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({
    scope: z
      .enum(['user', 'project'])
      .default('user')
      .describe('user (~/.claude) or project (repo .claude/settings.local.json)'),
    deny: z
      .boolean()
      .optional()
      .describe(
        'Project scope: merge the gh write deny rules (default); --no-deny skips them. User scope never adds them',
      ),
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
    if (input.scope === 'user' && input.deny === true) {
      throw new GhxError('VALIDATION', '--deny is for --scope project: user scope adds no deny rules.', {
        hint: 'Deny rules apply in every repo and cannot be conditional; at user scope the hook enforces only in repos with .github/ghx.json. Use --scope project for deny rules in one repo.',
        details: { issues: [{ path: 'deny', code: 'scope', message: '--deny needs --scope project' }] },
      });
    }
    const deny = input.scope === 'project' && input.deny !== false;
    const targets = await resolveTargets(input.scope, ctx.env, ctx.git);
    const command = input.hook ? hookCommand() : null;
    const changes: FileChange[] = [];

    // Plan and validate everything before writing anything.
    const manifest = readManifest(targets);
    const before = readOrNull(targets.settings);
    const parsed = parseSettings(before, targets.settings);
    const owned = ownedSettings(targets, manifest, parsed);
    // User scope: drop the deny rules an earlier ghx install added there, and only those.
    const drop = input.scope === 'user' ? owned.deny : [];
    let settingsRecord: Manifest['settings'] = manifest?.settings ?? null;
    if (deny || input.hook || input.hookMode || drop.length > 0) {
      const cleaned = removeDenyRules(parsed, drop, owned.containers);
      const next = installSettings(cleaned, { deny, hookCommand: command, hookMode: input.hookMode });
      const same = JSON.stringify(next) === JSON.stringify(parsed);
      if (drop.length > 0) {
        ctx.warn({
          code: 'INSTALL_DENY_REMOVED',
          message: `Removed ${drop.length} gh write deny rule(s) an earlier ghx install added to ${targets.settings}. User scope relies on the hook, which enforces only in repos with .github/ghx.json; use --scope project for deny rules in one repo.`,
        });
      }
      changes.push({
        path: targets.settings,
        kind: 'settings',
        before,
        after: same ? before : serializeSettings(next, before),
      });
      settingsRecord = {
        path: targets.settings,
        ...recordAdded(owned, parsed, next),
        created: owned.created ?? before === null,
      };
    }
    let claudeMdRecord: Manifest['claudeMd'] = manifest?.claudeMd ?? null;
    if (input.snippet) {
      const before = readOrNull(targets.claudeMd);
      const snippet = readFileSync(SNIPPET_PATH, 'utf8');
      // A block already there with no record is a legacy install's: it created the file if no backup exists.
      const legacy =
        before !== null && removeBlock(before, targets.claudeMd) === '' && backupsOf(targets.claudeMd).length === 0;
      claudeMdRecord ??= { path: targets.claudeMd, created: before === null || legacy };
      changes.push({
        path: targets.claudeMd,
        kind: 'claude-md',
        before,
        after: installBlock(before, snippet, targets.claudeMd),
      });
    }
    const binLink = input.binDir ? planBinLink(resolve(ctx.cwd, input.binDir), ctx.env) : null;

    const settingsChange = changes.find((c) => c.kind === 'settings');
    if (input.scope === 'project' && settingsChange && (await ctx.git.isIgnored(targets.settings)) === false) {
      ctx.warn({
        code: 'SETTINGS_LOCAL_NOT_IGNORED',
        message: `git does not ignore ${targets.settings}, which holds this machine's absolute hook paths; add .claude/settings.local.json to .gitignore so it isn't committed.`,
      });
    }
    const next = ['Start a new Claude Code session so it loads the settings.', 'Check the install: ghx doctor'];
    if (binLink && !binLink.onPath) next.push(`Add ${resolve(binLink.path, '..')} to PATH to run ghx by name.`);
    // The record changes only alongside a file change, so a no-op re-install writes nothing.
    const record = serializeManifest({ version: 1, settings: settingsRecord, claudeMd: claudeMdRecord });
    const manifestChange = changes.some((c) => c.before !== c.after)
      ? { path: manifestPath(targets), content: record }
      : undefined;
    return finish(
      {
        scope: targets.scope,
        backupDir: join(targets.stateDir, 'backups'),
        changes,
        hookCommand: command,
        denyRules: deny ? GHX_DENY_RULES : [],
        binLink,
        manifest: manifestChange,
      },
      { dryRun: ctx.dryRun, clock: ctx.clock, next },
    );
  },
});
