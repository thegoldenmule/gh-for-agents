#!/usr/bin/env node
// Drift check (03 §6.1): re-record every live:* scenario into a temp dir and compare SHAPES with the
// committed fixtures (key sets, JSON types, status lines, stderr with numbers masked). Exit 1 with a
// diff on any mismatch, so a gh or GitHub API change shows up before users hit it. Runs in the
// (deferred) live workflow; never in default CI.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_GH, listScenarioNames, loadScenarioModule, recordScenario } from './record.ts';
import { diffShapes, fixtureShape } from './shape.ts';

function readFixture(dir: string, file: string): { exitCode: number; stdout: string; stderr: string } {
  const f = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutFile?: string;
  };
  return { ...f, stdout: f.stdoutFile ? readFileSync(join(dir, f.stdoutFile), 'utf8') : f.stdout };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const problems: string[] = [];
  const checked: string[] = [];
  for (const name of listScenarioNames()) {
    if (only.length > 0 && !only.includes(name)) continue;
    const s = await loadScenarioModule(name);
    if (!s.source.startsWith('live:')) continue;
    const tmp = await recordScenario(s);
    for (const d of s.outDirs) {
      const committedDir = join(FIXTURE_GH, d);
      const freshDir = join(tmp, d);
      if (!existsSync(freshDir)) continue;
      for (const file of readdirSync(freshDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
        const fresh = JSON.parse(readFileSync(join(freshDir, file), 'utf8')) as { meta?: { source?: string } };
        if (!fresh.meta?.source?.startsWith('live:')) continue;
        if (!existsSync(join(committedDir, file))) {
          problems.push(`${d}/${file}: not committed (run pnpm fixtures:record ${name})`);
          continue;
        }
        problems.push(
          ...diffShapes(
            `${d}/${file}`,
            fixtureShape(readFixture(committedDir, file)),
            fixtureShape(readFixture(freshDir, file)),
          ),
        );
        checked.push(`${d}/${file}`);
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({ ok: problems.length === 0, checked: checked.length, problems }, null, 2)}\n`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
}

if (import.meta.main) await main();
