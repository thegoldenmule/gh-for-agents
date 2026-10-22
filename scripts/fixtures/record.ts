#!/usr/bin/env node
// Fixture recording (03 §6.1). `pnpm fixtures:record <scenario>` runs scripts/fixtures/scenarios/<scenario>.ts,
// which captures raw read-only gh calls (or ghx runs with GHX_RECORD_DIR) into a temp dir; the files are
// redacted and then replace the scenario's output directories under test/fixtures/gh/.
//
// Extension point: a scenario is ONE new file scripts/fixtures/scenarios/<name>.ts default-exporting
// defineScenario({...}). Discovered by file name; nothing central is edited. Until the sandbox exists
// (03 Q2, deferred), scenarios are read-only against public repos; mutating gh calls are refused.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGhEnv } from '../../src/gh/env.ts';
import { isMutating } from '../../src/gh/guard.ts';
import { redactDir } from './redact.ts';
import type { Captured, RecordContext, Scenario } from './scenario-api.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const FIXTURE_GH = join(ROOT, 'test', 'fixtures', 'gh');
export const SCENARIO_DIR = join(import.meta.dirname, 'scenarios');

export type { Captured, RecordContext, Scenario, Source } from './scenario-api.ts';

function runGh(argv: string[]): Captured {
  if (isMutating(argv)) throw new Error(`fixtures:record refuses a mutating gh call: gh ${argv.join(' ')}`);
  const r = spawnSync('gh', argv, {
    encoding: 'utf8',
    env: buildGhEnv(process.env) as NodeJS.ProcessEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { argv, exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function listScenarioNames(): string[] {
  return existsSync(SCENARIO_DIR)
    ? readdirSync(SCENARIO_DIR)
        .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
        .map((f) => f.slice(0, -3))
        .sort()
    : [];
}

export async function loadScenarioModule(name: string): Promise<Scenario> {
  const file = join(SCENARIO_DIR, `${name}.ts`);
  if (!existsSync(file)) throw new Error(`no scenario '${name}' (have: ${listScenarioNames().join(', ')})`);
  return ((await import(pathToFileURL(file).href)) as { default: Scenario }).default;
}

/** Record into `into` (a temp root by default); returns the directory holding <outDir>/… */
export async function recordScenario(
  s: Scenario,
  into = mkdtempSync(join(tmpdir(), `ghx-record-${s.name}-`)),
): Promise<string> {
  const ghVersion = /gh version (\S+)/.exec(runGh(['--version']).stdout)?.[1] ?? 'unknown';
  const recordedAt = new Date().toISOString();
  const viewer = runGh(['api', 'user', '--jq', '.login']).stdout.trim();
  const ctx: RecordContext = {
    ghVersion,
    recordedAt,
    gh: runGh,
    write(outDir, file, fixture) {
      mkdirSync(join(into, outDir), { recursive: true });
      writeFileSync(join(into, outDir, `${file}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    },
    capture(outDir, file, argv, o = {}) {
      const c = runGh(argv);
      const dir = join(into, outDir);
      mkdirSync(dir, { recursive: true });
      const meta = { source: o.source ?? s.source, recordedAt, ghVersion, ...(o.note ? { note: o.note } : {}) };
      if (o.stdoutFile) {
        writeFileSync(join(dir, `${file}.log`), c.stdout);
        ctx.write(outDir, file, {
          argv,
          exitCode: c.exitCode,
          stdout: '',
          stderr: c.stderr,
          stdoutFile: `${file}.log`,
          meta,
        });
      } else {
        ctx.write(outDir, file, { argv, exitCode: c.exitCode, stdout: c.stdout, stderr: c.stderr, meta });
      }
      return c;
    },
  };
  await s.record(ctx);
  redactDir(into, viewer ? { aliases: { [viewer]: 'viewer-user' } } : {});
  return into;
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || name === '--list') {
    process.stdout.write(`${JSON.stringify({ scenarios: listScenarioNames() })}\n`);
    return;
  }
  const s = await loadScenarioModule(name);
  const tmp = await recordScenario(s);
  for (const d of s.outDirs) {
    const target = join(FIXTURE_GH, d);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(join(tmp, d))) cpSync(join(tmp, d), target, { recursive: true });
  }
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ scenario: s.name, wrote: s.outDirs })}\n`);
}

if (import.meta.main) await main();
