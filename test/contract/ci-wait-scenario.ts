// Helpers for the ci wait contract tests: per-test fake-gh dirs, and scenarios recorded from the
// in-process GitHub sim (the spawned run makes the same first-tick calls, so the replies line up).
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { type Recorded, recordingRunner, writeScenario } from '../commands/ci-wait-record.ts';
import { GitHubSim, type SimState, wait } from '../commands/ci-wait-world.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { scratchDir } from '../helpers/harness.ts';

export function dirs() {
  const dir = mkdtempSync(join(scratchDir(), 'wait-contract-'));
  return {
    dir,
    log: join(dir, 'calls.ndjson'),
    env: (scenario: string, extra: Record<string, string> = {}) => ({
      GHX_FAKE_SCENARIO: scenario,
      GHX_FAKE_LOG: join(dir, 'calls.ndjson'),
      GHX_FAKE_STATE: join(dir, 'state'),
      GHX_ARTIFACT_DIR: join(dir, 'artifacts'),
      ...extra,
    }),
  };
}

/** Record the sim's first tick (or full run) for `argv` as a scenario directory; returns its path. */
export async function recordScenario(
  state: SimState,
  argv: string[],
  o: ConstructorParameters<typeof GitHubSim>[2] = {},
): Promise<{ scenario: string; calls: number }> {
  // Real "now", so job timestamps mean the same thing to the spawned process's real clock.
  const sim = new GitHubSim(new FakeClock(Date.now()), state, o);
  const rec: Recorded[] = [];
  const run = wait(sim, argv, { proc: recordingRunner(sim, rec), maxMs: 1 });
  await run.catch(() => {});
  const scenario = mkdtempSync(join(scratchDir(), 'wait-scenario-'));
  writeScenario(scenario, rec, 'recorded from the ci wait GitHub sim');
  return { scenario, calls: rec.length };
}
