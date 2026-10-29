// Compose a question's world into one fake-gh scenario directory (test/fixtures/bin/gh reads one directory).
// Base scenarios are copied in order, then the extras file's fixtures; file names get a source prefix so the
// fake gh's file order (which orders replies to the same argv) follows the world's source order. A fixture's
// stdoutFile is copied next to it under the prefixed name and the reference is rewritten.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { World } from './types.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
export const GH_FIXTURES = join(ROOT, 'test', 'fixtures', 'gh');
export const ORACLE_FIXTURES = join(ROOT, 'test', 'fixtures', 'eval', 'oracle');

interface FixtureFile {
  argv: string[];
  stdoutFile?: string;
  [k: string]: unknown;
}

/** An extras file: the fixtures in reply order, each with an optional file-name slug. */
export interface ExtrasFile {
  note?: string;
  fixtures: (FixtureFile & { name?: string })[];
}

function put(out: string, name: string, f: FixtureFile, srcDir: string): void {
  const fixture: FixtureFile = { ...f };
  if (typeof f.stdoutFile === 'string') {
    const logName = `${name.replace(/\.json$/, '')}--${basename(f.stdoutFile)}`;
    copyFileSync(resolve(srcDir, f.stdoutFile), join(out, logName));
    fixture.stdoutFile = logName;
  }
  writeFileSync(join(out, name), `${JSON.stringify(fixture, null, 2)}\n`);
}

export function loadExtras(name: string): ExtrasFile {
  return JSON.parse(readFileSync(join(ORACLE_FIXTURES, `${name}.json`), 'utf8')) as ExtrasFile;
}

/** Write the world's composed scenario into `out` (created) and return the number of fixtures. */
export function composeWorld(world: World, out: string): number {
  mkdirSync(out, { recursive: true });
  let n = 0;
  world.base.forEach((b, i) => {
    const dir = join(GH_FIXTURES, b.scenario);
    if (!existsSync(dir)) throw new Error(`oracle: scenario ${b.scenario} not found at ${dir}`);
    const skip = new Set(b.skip ?? []);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !skip.has(f))
      .sort()) {
      const f = JSON.parse(readFileSync(join(dir, file), 'utf8')) as FixtureFile;
      put(out, `${String(i).padStart(2, '0')}-${file}`, f, dir);
      n++;
    }
    for (const s of skip) {
      if (!existsSync(join(dir, s))) throw new Error(`oracle: ${b.scenario} has no ${s} to skip`);
    }
  });
  if (world.extras !== undefined) {
    const extras = loadExtras(world.extras);
    extras.fixtures.forEach(({ name, ...f }, j) => {
      const slug = (name ?? f.argv.slice(0, 3).join('-')).replace(/[^A-Za-z0-9_.-]+/g, '-');
      put(out, `90-${String(j).padStart(3, '0')}-${slug}.json`, f, ORACLE_FIXTURES);
      n++;
    });
  }
  return n;
}

/**
 * The `.github/ghx.json` a composed world serves through the contents API (base64, from the first
 * `contents/.github/ghx.json` fixture that succeeds), or null when it serves none. ghx reads the checkout's
 * copy when the cwd is the target repo, so the checkout must carry the same file.
 */
export function worldConfig(scenarioDir: string): string | null {
  for (const file of readdirSync(scenarioDir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const f = JSON.parse(readFileSync(join(scenarioDir, file), 'utf8')) as FixtureFile & {
      exitCode?: number;
      stdout?: string;
    };
    if (!f.argv.some((a) => a.endsWith('/contents/.github/ghx.json'))) continue;
    if ((f.exitCode ?? 0) !== 0 || typeof f.stdout !== 'string') return null;
    const sep = f.stdout.indexOf('\r\n\r\n');
    const body = JSON.parse(sep >= 0 ? f.stdout.slice(sep + 4) : f.stdout) as { content?: string };
    return body.content === undefined ? null : Buffer.from(body.content, 'base64').toString('utf8');
  }
  return null;
}
