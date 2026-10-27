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
import { findBlock, installBlock, removeBlock } from '../install/claude-md.ts';
import {
  backupsOf,
  type FileChange,
  hookCommand,
  planBinLink,
  REPO_ROOT,
  readOrNull,
  resolveTargets,
  SNIPPET_PATH,
} from '../install/files.ts';
import { handoff, runsFromNpx } from '../install/npx.ts';
import {
  type Manifest,
  manifestPath,
  nextRestore,
  ownedSettings,
  readManifest,
  serializeManifest,
} from '../install/owned.ts';
import { finish, InstallOutput } from '../install/report.ts';
import {
  GHX_DENY_RULES,
  inspectSettings,
  installSettings,
  keepsFormatting,
  parseSettings,
  recordAdded,
  removeDenyRules,
  serializeSettings,
} from '../install/settings.ts';
import { reformattedWarning, styleKeepsBytes, toPlain } from '../install/text.ts';

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
    'files[].backup gives each path) beside the record of what it added, and writes atomically. The hook runs this ghx by absolute path. ' +
    'Run from npx, it first runs npm i -g @thegoldenmule/ghx@<this version> and hands the install to that global copy (handoff); --no-global refuses instead. ' +
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
    binDir: z
      .string()
      .min(1)
      .optional()
      .describe('Also symlink <dir>/ghx to bin/ghx.js (recorded, so uninstall removes it without the flag)'),
    hookMode: z
      .enum(['ask', 'deny'])
      .optional()
      .describe('ask sets env.GHX_HOOK_MODE=ask; deny removes it (the default mode)'),
    global: z
      .boolean()
      .default(true)
      .describe('From npx: install ghx globally first (default); --no-global refuses instead'),
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
    // From the npx cache: install globally and let that copy do the install, so the hook points there.
    if (runsFromNpx(REPO_ROOT, ctx.env)) {
      const out = await handoff(input, ctx, REPO_ROOT);
      if (out) return out;
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
      const after = same ? before : serializeSettings(next, before);
      if (!same && before !== null && !keepsFormatting(before, parsed)) ctx.warn(reformattedWarning(targets.settings));
      const ghxFree = inspectSettings(parsed).hookCommands.length === 0 && owned.deny.length === 0;
      settingsRecord = {
        path: targets.settings,
        ...recordAdded(owned, parsed, next),
        created: owned.created ?? before === null,
        restore: nextRestore(manifest?.settings ?? null, before, after, ghxFree),
      };
    }
    let claudeMdRecord: Manifest['claudeMd'] = manifest?.claudeMd ?? null;
    if (input.snippet) {
      const before = readOrNull(targets.claudeMd);
      const snippet = readFileSync(SNIPPET_PATH, 'utf8');
      // A block already there with no record is a legacy install's: it created the file if no backup exists.
      const legacy =
        before !== null && removeBlock(before, targets.claudeMd) === '' && backupsOf(targets.claudeMd).length === 0;
      const after = installBlock(before, snippet, targets.claudeMd);
      const ghxFree = before === null || findBlock(toPlain(before), targets.claudeMd) === null;
      if (before !== null && after !== before && !styleKeepsBytes(before))
        ctx.warn(reformattedWarning(targets.claudeMd));
      claudeMdRecord = {
        path: targets.claudeMd,
        created: claudeMdRecord?.created ?? (before === null || legacy),
        restore: nextRestore(claudeMdRecord, before, after, ghxFree),
      };
      changes.push({ path: targets.claudeMd, kind: 'claude-md', before, after });
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
    // The bin link is recorded so uninstall finds it without --bin-dir; without --bin-dir the old record stays.
    const binRecord = binLink ? { path: binLink.path, target: binLink.target } : (manifest?.binLink ?? null);
    const binRecordChanged = JSON.stringify(binRecord) !== JSON.stringify(manifest?.binLink ?? null);
    // The record changes only alongside a change, so a no-op re-install writes nothing.
    const record = serializeManifest({
      version: 1,
      settings: settingsRecord,
      claudeMd: claudeMdRecord,
      binLink: binRecord,
    });
    const manifestChange =
      changes.some((c) => c.before !== c.after) || binLink?.action === 'created' || binRecordChanged
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
