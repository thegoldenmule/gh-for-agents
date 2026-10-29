// The `gh` every oracle answer sees: test/fixtures/bin/gh (which matches, replies and logs), plus one piece of
// world state the static fixtures cannot hold: what a write sent. A write with a JSON body on stdin
// (`gh api -X POST|PATCH|PUT … --input -`) is recorded in GHX_FAKE_STATE, and a reply may quote its fields as
// `{{posted:<field>}}`, replaced by the JSON-escaped value. So a read-back returns exactly what was posted
// (ghx pr create checks the stored body byte for byte, and that body carries a random block id).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FAKE_GH = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'bin', 'gh');
const PLACEHOLDER = /\{\{posted:([A-Za-z0-9_]+)\}\}/g;

/** Replace `{{posted:<field>}}` with the JSON-escaped field of the last recorded write (unknown fields stay). */
export function fillPosted(text: string, posted: Record<string, unknown> | null): string {
  if (posted === null) return text;
  return text.replace(PLACEHOLDER, (m, field: string) =>
    field in posted ? JSON.stringify(String(posted[field])).slice(1, -1) : m,
  );
}

/** Is this argv a write whose body comes from stdin? */
export function isJsonWrite(argv: readonly string[]): boolean {
  const i = argv.indexOf('-X');
  const method = i >= 0 ? argv[i + 1] : undefined;
  return argv[0] === 'api' && ['POST', 'PATCH', 'PUT'].includes(method ?? '') && argv.includes('--input');
}

function readStdin(): string | undefined {
  try {
    const s = readFileSync(0, 'utf8');
    return s === '' ? undefined : s;
  } catch {
    return undefined;
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const stdin = readStdin();
  const state = process.env.GHX_FAKE_STATE;
  const postedFile = state ? join(state, 'oracle-posted.json') : undefined;
  if (postedFile && stdin !== undefined && isJsonWrite(argv)) {
    try {
      writeFileSync(postedFile, JSON.stringify(JSON.parse(stdin)));
    } catch {
      // not JSON: nothing to record
    }
  }
  const r = spawnSync(process.execPath, [FAKE_GH, ...argv], {
    input: stdin ?? '',
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  const posted =
    postedFile && existsSync(postedFile)
      ? (JSON.parse(readFileSync(postedFile, 'utf8')) as Record<string, unknown>)
      : null;
  process.stdout.write(fillPosted(r.stdout.toString('utf8'), posted));
  process.stderr.write(r.stderr);
  return r.status ?? 1;
}

if (import.meta.main) process.exitCode = main();
