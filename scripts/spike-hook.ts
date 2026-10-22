#!/usr/bin/env node
// Claude Code PreToolUse hook probe (03 §3.6). Re-run after each Claude Code upgrade:
//
//   node scripts/spike-hook.ts                 # run probes A–D, print one JSON report
//   node scripts/spike-hook.ts --record <dir>  # also write the logged hook payloads to <dir>/*.json
//   node scripts/spike-hook.ts --keep          # keep the temp dir for inspection
//
// Everything happens inside a fresh mkdtemp directory: the throwaway hook, its log, and a scratch
// settings file passed with --settings. The user's own settings (~/.claude/**, project settings)
// are never read or written by this script. The child `claude -p` runs with that temp dir as cwd.
//
// Probes:
//   A  updatedInput sets run_in_background on a foreground Bash call, with no permissionDecision
//   B  updatedInput rewrites `command`, with no permissionDecision
//   C  a rewrite into a command the scratch permissions.deny forbids is still denied
//   D  a `Bash|Monitor` matcher fires for Monitor (logged only)
//
// Zero dependencies on purpose; it predates package.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK_SOURCE = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
const dir = process.env.GHX_SPIKE_DIR;
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch {}
let ev = {};
try { ev = JSON.parse(raw); } catch {}
appendFileSync(dir + '/hook-log.ndjson', JSON.stringify(ev) + '\n');
const input = ev.tool_input ?? {};
const cmd = typeof input.command === 'string' ? input.command : '';
let updated = null;
if (ev.tool_name === 'Bash' && cmd.includes('GHXSPIKE-A')) updated = { ...input, run_in_background: true };
if (ev.tool_name === 'Bash' && cmd.includes('GHXSPIKE-B')) updated = { ...input, command: 'echo GHXSPIKE-B-rewritten' };
if (ev.tool_name === 'Bash' && cmd.includes('GHXSPIKE-C')) updated = { ...input, command: 'touch ' + dir + '/should-not-exist' };
if (updated) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }));
}
process.exit(0);
`;

const PROMPT = [
  'This is an automated probe. Do exactly the following, nothing else, and do not explain.',
  '1. Run the Bash command `echo GHXSPIKE-A` in the foreground (do not set run_in_background yourself).',
  '2. Run the Bash command `echo GHXSPIKE-B`.',
  '3. Run the Bash command `echo GHXSPIKE-C`.',
  '4. Use the Monitor tool with the command `echo GHXSPIKE-D` (any short timeout). If Monitor is unavailable, skip it.',
  '5. Reply with the single word DONE.',
].join('\n');

interface Report {
  claudeVersion: string | null;
  ranAt: string;
  tmpDir: string;
  exitCode: number | null;
  probes: Record<string, { honoured: boolean | null; evidence: string }>;
  assumptions: Record<string, boolean>;
  stderrTail?: string;
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GHX_SPIKE_DIR: dir };
  // Don't let the child think it is nested inside this session.
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT' || k.startsWith('CLAUDE_CODE_SSE')) delete env[k];
  }
  return env;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  return JSON.stringify(content ?? '');
}

function main(): void {
  const args = process.argv.slice(2);
  const recordIdx = args.indexOf('--record');
  const recordDir = recordIdx >= 0 ? args[recordIdx + 1] : undefined;
  const keep = args.includes('--keep');

  const dir = mkdtempSync(join(tmpdir(), 'ghx-spike-hook-'));
  const hookPath = join(dir, 'hook.mjs');
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(hookPath, HOOK_SOURCE);
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: { deny: ['Bash(touch:*)'] },
        hooks: {
          PreToolUse: [
            { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}` }] },
          ],
        },
      },
      null,
      2,
    ),
  );

  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', env: childEnv(dir) }).stdout?.trim() ?? null;
  const run = spawnSync(
    'claude',
    [
      '-p',
      PROMPT,
      '--settings',
      settingsPath,
      '--allowedTools',
      'Bash(echo:*)',
      'Monitor',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    { cwd: dir, encoding: 'utf8', env: childEnv(dir), timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );

  const events: Record<string, unknown>[] = [];
  for (const line of (run.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // ignore non-JSON lines
    }
  }
  writeFileSync(join(dir, 'stream.ndjson'), run.stdout ?? '');

  // tool_use id → original input; tool_result id → text
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const results = new Map<string, string>();
  for (const ev of events) {
    const msg = ev.message as { content?: unknown[] } | undefined;
    for (const c of (msg?.content ?? []) as Record<string, unknown>[]) {
      if (c.type === 'tool_use')
        uses.set(String(c.id), { name: String(c.name), input: (c.input ?? {}) as Record<string, unknown> });
      if (c.type === 'tool_result') results.set(String(c.tool_use_id), textOf(c.content));
    }
  }
  const resultFor = (needle: string): string | undefined => {
    for (const [id, u] of uses) if (String(u.input.command ?? '').includes(needle)) return results.get(id);
    return undefined;
  };
  const sawNotification =
    (run.stdout ?? '').includes('task_notification') || (run.stdout ?? '').includes('task-notification');

  const hookLog = existsSync(join(dir, 'hook-log.ndjson'))
    ? readFileSync(join(dir, 'hook-log.ndjson'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

  const a = resultFor('GHXSPIKE-A') ?? '';
  const b = resultFor('GHXSPIKE-B') ?? '';
  const c = resultFor('GHXSPIKE-C') ?? '';
  const monitorHook = hookLog.find((e) => e.tool_name === 'Monitor');
  const report: Report = {
    claudeVersion: version,
    ranAt: new Date().toISOString(),
    tmpDir: dir,
    exitCode: run.status,
    probes: {
      A: {
        honoured: /running in background/i.test(a),
        evidence: `${a.slice(0, 200)}${sawNotification ? ' [task_notification seen]' : ''}`,
      },
      B: { honoured: b.includes('GHXSPIKE-B-rewritten'), evidence: b.slice(0, 200) },
      C: {
        honoured: /denied/i.test(c) && !existsSync(join(dir, 'should-not-exist')),
        evidence: c.slice(0, 200),
      },
      D: {
        honoured: monitorHook ? true : null,
        evidence: monitorHook ? JSON.stringify(monitorHook.tool_input).slice(0, 200) : 'Monitor not invoked',
      },
    },
    assumptions: {},
  };
  report.assumptions['hook.updatedInput-sets-background'] = report.probes.A?.honoured === true;
  report.assumptions['hook.updatedInput-rewrites-command'] = report.probes.B?.honoured === true;
  report.assumptions['hook.rules-apply-to-rewrite'] = report.probes.C?.honoured === true;
  if (run.status !== 0) report.stderrTail = (run.stderr ?? '').slice(-1000);

  if (recordDir) {
    const out = resolve(recordDir);
    mkdirSync(out, { recursive: true });
    hookLog.forEach((ev, i) => {
      const tool = String(ev.tool_name ?? 'unknown').toLowerCase();
      const payload = {
        meta: { source: 'live:spike-hook', recordedAt: report.ranAt, claudeVersion: version },
        event: { tool_name: ev.tool_name, tool_input: ev.tool_input, hook_event_name: ev.hook_event_name },
      };
      writeFileSync(
        join(out, `spike-${String(i + 1).padStart(2, '0')}-${tool}.json`),
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!keep) rmSync(dir, { recursive: true, force: true });
  process.exitCode = Object.values(report.assumptions).every(Boolean) ? 0 : 1;
}

main();
