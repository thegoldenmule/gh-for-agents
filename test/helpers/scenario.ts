// Scenario helpers (03 §4.2): test/fixtures/gh/<scenario>/ directories, discovered by name.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeClock } from './fake-clock.ts';
import { FakeGh } from './fake-gh.ts';
import { GH_FIXTURE_ROOT, loadScenario, resolveScenarioDir } from './fixture-match.ts';

export { GH_FIXTURE_ROOT, loadScenario, resolveScenarioDir };

/** Every scenario directory (nested groups like ci-snapshot/pending included), sorted. */
export function listScenarios(root = GH_FIXTURE_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir).filter((e) => !e.startsWith('_') && !e.startsWith('.'));
    if (entries.some((e) => e.endsWith('.json'))) out.push(rel);
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, rel ? `${rel}/${e}` : e);
    }
  };
  if (existsSync(root)) walk(root, '');
  return out.sort();
}

export function scenario(name: string, o: { clock?: FakeClock } = {}): FakeGh {
  return FakeGh.fromScenario(name, o);
}
