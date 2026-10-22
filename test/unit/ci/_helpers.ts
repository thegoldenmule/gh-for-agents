// Shared setup for the CI-core tests: a read-mode gh client over FakeGh, an artifact store in a temp
// dir, and a warning collector.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArtifactStore, createArtifactStore } from '../../../src/core/artifacts.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { createGh, type Gh } from '../../../src/gh/index.ts';
import type { RepoRef } from '../../../src/gh/types.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';

export const repoOf = (slug: string): RepoRef => {
  const [owner = '', name = ''] = slug.split('/');
  return { host: 'github.com', owner, name };
};

let root: string | undefined;
export function tempRoot(): string {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'ghx-ci-'));
    const dir = root;
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return root;
}

export interface CiEnv {
  fake: FakeGh;
  gh: Gh;
  clock: FakeClock;
  artifacts: ArtifactStore;
  warnings: { code: string; message: string }[];
  warn: (w: { code: string; message: string }) => void;
}

export function ciEnv(scenario?: string, o: { clock?: FakeClock } = {}): CiEnv {
  const clock = o.clock ?? new FakeClock();
  const fake = scenario ? FakeGh.fromScenario(scenario, { clock }) : new FakeGh({ clock });
  const gh = createGh({
    proc: fake.runner(),
    clock,
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
  const artifacts = createArtifactStore({ root: mkdtempSync(join(tempRoot(), 'a-')), clock });
  const warnings: { code: string; message: string }[] = [];
  return { fake, gh, clock, artifacts, warnings, warn: (w) => warnings.push(w) };
}

/** An `api --include` stdout. */
export function httpReply(status: string, body: string, headers: Record<string, string> = {}): string {
  const h = { 'Content-Type': 'application/json; charset=utf-8', ...headers };
  return [status, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n');
}

/** A 200 JSON reply for FakeGh.on(). */
export const ok = (body: unknown) => ({
  exitCode: 0,
  stdout: httpReply('HTTP/2.0 200 OK', JSON.stringify(body)),
  stderr: '',
});

/** A GitHub JSON 404 for FakeGh.on(). */
export const notFound = () => ({
  exitCode: 1,
  stdout: httpReply(
    'HTTP/2.0 404 Not Found',
    '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
  ),
  stderr: 'gh: Not Found (HTTP 404)\n',
});
