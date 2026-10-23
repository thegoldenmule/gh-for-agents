// The document `ghx install` and `ghx uninstall` print, and the commit step they share: under
// --dry-run nothing is written and each planned change comes back as a unified diff in `wouldRun`.

import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Clock } from '../core/clock.ts';
import {
  actionOf,
  assertDirWritable,
  assertWritable,
  atomicWrite,
  type BinLink,
  commitBinLink,
  commitChanges,
  diffOf,
  type FileChange,
  type FileResult,
  notWritable,
  type Scope,
} from './files.ts';

const Action = z.enum(['created', 'updated', 'unchanged', 'removed']);

export const InstallOutput = z.object({
  scope: z.enum(['user', 'project']),
  dryRun: z.boolean(),
  changed: z.array(z.string()).describe('Paths written (or, with --dry-run, that would be)'),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['settings', 'claude-md']),
      action: Action,
      backup: z
        .string()
        .nullable()
        .describe('Copy of the file as it was, under <config dir>/ghx-install/; null when unchanged or new'),
    }),
  ),
  hookCommand: z.string().nullable(),
  denyRules: z.array(z.string()),
  binLink: z
    .object({
      path: z.string(),
      target: z.string(),
      action: z.enum(['created', 'unchanged', 'removed', 'absent']),
      onPath: z.boolean(),
    })
    .nullable(),
  wouldRun: z
    .array(z.object({ path: z.string(), action: Action, diff: z.string() }))
    .optional()
    .describe('--dry-run only: each planned change as a unified diff'),
  handoff: z
    .object({
      from: z.string().describe('The npx cache copy of ghx that ran'),
      install: z.array(z.string()).describe('The global install it ran (or, with --dry-run, would run)'),
      prefix: z.string().describe('npm prefix -g'),
      bin: z.string().describe('The global ghx that ran the install'),
      args: z.array(z.string()).describe('What it ran that ghx with'),
    })
    .optional()
    .describe('Run from npx: ghx installed itself globally and handed the install to that copy'),
  next: z.array(z.string()),
});
export type InstallOutput = z.input<typeof InstallOutput>;

export interface Plan {
  scope: Scope;
  /** Where backups of changed files go: Targets.stateDir/backups, in the user config dir. */
  backupDir: string;
  changes: FileChange[];
  hookCommand: string | null;
  denyRules: readonly string[];
  binLink: BinLink | null;
  /** ghx's install record, written (or removed, when null) after the files; never under --dry-run. */
  manifest?: { path: string; content: string | null } | undefined;
}

/** Apply a validated plan (or describe it, under dry-run) and build the output document. */
export function finish(plan: Plan, o: { dryRun: boolean; clock: Clock; next: string[] }): InstallOutput {
  const changedFiles = plan.changes.filter((c) => c.before !== c.after);
  // Check every write before making any, so a permission problem is a clean refusal, not a half install
  // (under --dry-run too: the preview should fail the way the real run would).
  for (const c of changedFiles) assertWritable(c.path);
  if (changedFiles.some((c) => c.before !== null)) assertDirWritable(plan.backupDir);
  if (plan.manifest) assertDirWritable(dirname(plan.manifest.path));
  if (plan.binLink?.action === 'created' || plan.binLink?.action === 'removed')
    assertDirWritable(dirname(plan.binLink.path));
  const linkChanges = plan.binLink && (plan.binLink.action === 'created' || plan.binLink.action === 'removed');
  const changed = [...changedFiles.map((c) => c.path), ...(linkChanges && plan.binLink ? [plan.binLink.path] : [])];
  let files: FileResult[];
  let wouldRun: InstallOutput['wouldRun'];
  if (o.dryRun) {
    files = plan.changes.map((c) => ({ path: c.path, kind: c.kind, action: actionOf(c), backup: null }));
    wouldRun = changedFiles.map((c) => ({ path: c.path, action: actionOf(c), diff: diffOf(c) }));
    if (linkChanges && plan.binLink) {
      const l = plan.binLink;
      wouldRun.push({
        path: l.path,
        action: l.action === 'created' ? 'created' : 'removed',
        diff: l.action === 'created' ? `symlink ${l.path} -> ${l.target}\n` : `rm ${l.path}\n`,
      });
    }
  } else {
    files = commitChanges(plan.changes, o.clock, plan.backupDir);
    if (plan.binLink) commitBinLink(plan.binLink);
    const m = plan.manifest;
    try {
      if (m?.content === null) rmSync(m.path, { force: true });
      else if (m) atomicWrite(m.path, m.content);
    } catch (e) {
      throw notWritable(e, m?.path ?? '');
    }
  }
  return {
    scope: plan.scope,
    dryRun: o.dryRun,
    changed,
    files,
    hookCommand: plan.hookCommand,
    denyRules: [...plan.denyRules],
    binLink: plan.binLink,
    ...(wouldRun ? { wouldRun } : {}),
    next: o.dryRun
      ? changed.length > 0
        ? ['Nothing was written. Run the same command without --dry-run to apply it.']
        : ['Nothing to change.']
      : o.next,
  };
}
