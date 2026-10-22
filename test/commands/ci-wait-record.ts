// Records a GitHubSim run as a gh fixture scenario (NNN-<slug>.json, file order = reply order), so
// the spawned-bin contract tests and the registry smoke run replay exactly what the sim answered.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessRunner } from '../../src/proc/runner.ts';
import { endpoint, type GitHubSim } from './ci-wait-world.ts';

export interface Recorded {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Wrap the sim's runner so every gh call and its reply are kept (stdout as gh printed it). */
export function recordingRunner(sim: GitHubSim, out: Recorded[]): ProcessRunner {
  const inner = sim.runner();
  return async (req) => {
    const { stdoutFile: _file, ...plain } = req;
    const r = await inner(plain);
    out.push({ argv: [...req.args], exitCode: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr });
    if (req.stdoutFile) {
      writeFileSync(req.stdoutFile, r.stdout);
      return { ...r, stdout: '' };
    }
    return r;
  };
}

/** Write the recorded calls as a scenario directory. */
export function writeScenario(dir: string, calls: readonly Recorded[], note: string): void {
  mkdirSync(dir, { recursive: true });
  calls.forEach((c, i) => {
    const slug = (endpoint(c.argv) ?? 'call')
      .replace(/^repos\/[^/]+\/[^/]+\/?/, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const file = join(dir, `${String(i + 1).padStart(3, '0')}-${slug || 'repo'}.json`);
    writeFileSync(
      file,
      `${JSON.stringify({ argv: c.argv, exitCode: c.exitCode, stdout: c.stdout, stderr: c.stderr, meta: { source: 'synthetic', note } }, null, 2)}\n`,
    );
  });
}
