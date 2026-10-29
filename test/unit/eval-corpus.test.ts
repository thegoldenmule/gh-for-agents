// ghx-eval M0 (plan 07): the JSONL reader, manifests, snapshots and incremental ingest, over the hand-built
// corpus in test/fixtures/eval/corpus and temp copies of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { listCommands } from '../../scripts/eval/cli.ts';
import {
  comparePaths,
  manifestHash,
  parseManifest,
  readManifest,
  serializeManifest,
  verifyManifest,
  writeManifest,
} from '../../scripts/eval/corpus/manifest.ts';
import { parseJsonl, readJsonl, readJsonlAll, readJsonlSync } from '../../scripts/eval/corpus/read.ts';
import { isCorpusFile, snapshot, walkCorpus } from '../../scripts/eval/corpus/snapshot.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const CORPUS = join(ROOT, 'test', 'fixtures', 'eval', 'corpus');
const PROJECTS = join(CORPUS, 'projects');
const CHECKED_IN = join(CORPUS, 'manifest.json');
const MAIN = join(PROJECTS, '-tmp-proj-alpha', 'sess-0001.jsonl');
const AGENT = join(PROJECTS, '-tmp-proj-alpha', 'sess-0001', 'subagents', 'agent-a0001.jsonl');
const FUTURE = new Date('2100-01-01T00:00:00.000Z');
const HOUR = 3_600_000;

const temps: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ghx-eval-'));
  temps.push(d);
  return d;
};
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A temp copy of the fixture corpus, every file's mtime set to `mtime`. */
function corpusCopy(mtime: Date): string {
  const dir = join(temp(), 'projects');
  cpSync(PROJECTS, dir, { recursive: true });
  for (const w of [...walkCorpus(dir).files, ...walkCorpus(dir).unmatched]) utimesSync(w.abs, mtime, mtime);
  return dir;
}

// --- read.ts ---

test('parseJsonl: byte offsets across multibyte text, last-newline stop, trailing bytes', () => {
  const text = '{"a":"é✓"}\n{"b":2}\n{"c":';
  const { entries, stats } = parseJsonl(text);
  const first = Buffer.byteLength('{"a":"é✓"}\n');
  assert.deepEqual(
    entries.map((e) => [e.ok, e.offset, e.next, e.index]),
    [
      [true, 0, first, 0],
      [true, first, first + 8, 1],
    ],
  );
  assert.deepEqual(entries[0]!.record, { a: 'é✓' });
  assert.equal(stats.end, first + 8);
  assert.equal(stats.trailing, Buffer.byteLength('{"c":'));
  assert.equal(parseJsonl('{"x":1}').entries.length, 0, 'no newline, no line');
});

test('parseJsonl: a malformed line is yielded as an error and counted; blank lines skipped; CR stripped', () => {
  const { entries, stats } = parseJsonl('{"a":1}\r\nnot json\n\n   \n{"b":2}\n');
  assert.deepEqual(
    entries.map((e) => [e.ok, e.line]),
    [
      [true, '{"a":1}'],
      [false, 'not json'],
      [true, '{"b":2}'],
    ],
  );
  const err = entries[1]!;
  assert.ok(!err.ok && err.error.length > 0 && err.record === undefined);
  assert.deepEqual([stats.lines, stats.records, stats.errors, stats.blank], [5, 2, 1, 2]);
});

test('readJsonl stops at the last newline of a live file and resumes from stats.end', async () => {
  const bytes = readFileSync(MAIN);
  const lastNl = bytes.lastIndexOf(0x0a) + 1;
  const { entries, stats } = await readJsonlAll(MAIN);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => e.ok));
  assert.equal(stats.end, lastNl);
  assert.equal(stats.trailing, bytes.length - lastNl, 'the partial last line is not yielded');
  for (const e of entries) assert.equal(bytes.subarray(e.offset, e.next).toString('utf8'), `${e.line}\n`);

  // The writer finishes the line and adds another; an incremental read sees exactly the new lines.
  const live = join(temp(), 'live.jsonl');
  writeFileSync(live, bytes);
  appendFileSync(live, '0Z"}\n{"type":"user"}\n');
  const more = await readJsonlAll(live, { start: stats.end });
  assert.deepEqual(
    more.entries.map((e) => [e.offset, e.ok]),
    [
      [lastNl, true],
      [more.entries[1]!.offset, true],
    ],
  );
  assert.equal(more.stats.end, statSync(live).size);
  assert.equal(more.stats.trailing, 0);
});

test('readJsonl: chunk boundaries, end bound and the sync reader agree', async () => {
  const all = await readJsonlAll(AGENT);
  assert.deepEqual(
    all.entries.map((e) => e.ok),
    [true, false, true],
  );
  assert.equal(all.stats.blank, 1);
  for (const chunkSize of [1, 7, 64]) {
    assert.deepEqual(await readJsonlAll(AGENT, { chunkSize }), all, `chunkSize ${chunkSize}`);
    assert.deepEqual(readJsonlSync(AGENT, { chunkSize }), all, `sync chunkSize ${chunkSize}`);
  }
  const midSecond = all.entries[1]!.offset + 3;
  const bounded = readJsonlSync(AGENT, { end: midSecond });
  assert.equal(bounded.entries.length, 1);
  assert.equal(bounded.stats.end, all.entries[1]!.offset);
  assert.equal(bounded.stats.trailing, 3);

  let seen = 0;
  for await (const e of readJsonl(AGENT)) {
    seen += e.ok ? 1 : 0;
    break;
  }
  assert.equal(seen, 1, 'breaking out early closes the file');
});

// --- manifest.ts and snapshot.ts ---

test('paths sort by UTF-8 bytes, not UTF-16 code units or locale', () => {
  const paths = ['b', '\u{1F600}', 'B', '｡', 'a', 'é'];
  assert.deepEqual([...paths].sort(comparePaths), ['B', 'a', 'b', 'é', '｡', '\u{1F600}']);
});

test('isCorpusFile: transcripts, meta and skill-fork files only', () => {
  for (const n of ['s.jsonl', 'agent-x.meta.json', 'agent-x.forked-skill.json', 'agent-x.forked-skill.marker.json']) {
    assert.ok(isCorpusFile(n), n);
  }
  for (const n of ['toolu-0001.txt', '_meta.json', 'sessions-index.json', 'x.json']) assert.ok(!isCorpusFile(n), n);
});

test('the fixture corpus hashes to its checked-in manifest (mtime is not part of the hash)', () => {
  const { manifest, rootDir } = readManifest(CHECKED_IN);
  assert.equal(rootDir, PROJECTS);
  const fresh = snapshot({ root: PROJECTS, now: FUTURE });
  assert.equal(fresh.hash, manifest.hash);
  assert.deepEqual(
    fresh.files.map((f) => f.path),
    [
      '-tmp-proj-alpha/sess-0001.jsonl',
      '-tmp-proj-alpha/sess-0001/subagents/agent-a0001.jsonl',
      '-tmp-proj-alpha/sess-0001/subagents/agent-a0001.meta.json',
      '-tmp-proj-alpha/sess-0001/subagents/agent-a0002.forked-skill.json',
      '-tmp-proj-alpha/sess-0001/subagents/agent-a0002.forked-skill.marker.json',
      '-tmp-proj-beta/sess-0002.jsonl',
    ],
  );
  assert.deepEqual(
    walkCorpus(PROJECTS).unmatched.map((w) => w.path),
    [
      '-tmp-proj-alpha/_meta.json',
      '-tmp-proj-alpha/sess-0001/subagents/_meta.json',
      '-tmp-proj-alpha/sess-0001/tool-results/_meta.json',
      '-tmp-proj-alpha/sess-0001/tool-results/toolu-0001.txt',
      '-tmp-proj-beta/_meta.json',
    ],
  );
  assert.deepEqual(fresh.excluded.unmatched.files, 5);
  assert.deepEqual(verifyManifest(manifest, rootDir), { ok: true, missing: [], changed: [] });
});

test('M0 done-when: two snapshots of an unchanged corpus give the same hash and the same bytes', () => {
  const a = snapshot({ root: PROJECTS, now: FUTURE });
  const b = snapshot({ root: PROJECTS, now: FUTURE });
  assert.equal(a.hash, b.hash);
  assert.equal(serializeManifest(a), serializeManifest(b));
});

test('touching every file changes the recorded mtimes but not the hash', () => {
  const x = snapshot({ root: corpusCopy(new Date('2026-01-01T00:00:00Z')), now: FUTURE });
  const y = snapshot({ root: corpusCopy(new Date('2026-06-01T12:34:56Z')), now: FUTURE });
  assert.notDeepEqual(
    x.files.map((f) => f.mtime),
    y.files.map((f) => f.mtime),
  );
  assert.equal(x.hash, y.hash);
  assert.equal(x.hash, snapshot({ root: PROJECTS, now: FUTURE }).hash);
});

test('files modified within the window before the injected now are excluded, counted, and the cutoff recorded', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const dir = corpusCopy(new Date(now.getTime() - 7 * HOUR));
  const recent = join(dir, '-tmp-proj-beta', 'sess-0002.jsonl');
  utimesSync(recent, new Date(now.getTime() - HOUR), new Date(now.getTime() - HOUR));
  const edge = join(dir, '-tmp-proj-alpha', 'sess-0001.jsonl');
  utimesSync(edge, new Date(now.getTime() - 6 * HOUR), new Date(now.getTime() - 6 * HOUR));

  const m = snapshot({ root: dir, now });
  assert.equal(m.cutoff, '2026-10-29T06:00:00.000Z');
  assert.equal(m.createdAt, now.toISOString());
  assert.deepEqual(m.excluded.recent, { files: 1, bytes: statSync(recent).size });
  assert.ok(!m.files.some((f) => f.path === '-tmp-proj-beta/sess-0002.jsonl'));
  assert.ok(
    m.files.some((f) => f.path === '-tmp-proj-alpha/sess-0001.jsonl'),
    'exactly at the cutoff is included',
  );
  assert.equal(m.counts.files, 5);
  assert.equal(snapshot({ root: dir, now, windowHours: 0 }).counts.files, 6);
});

test('manifests round-trip with a root relative to the file, and tampering is caught', () => {
  const dir = corpusCopy(new Date('2026-01-01T00:00:00Z'));
  const out = join(dir, '..', 'manifests', 'm.json');
  const text = writeManifest(out, snapshot({ root: dir, now: FUTURE }));
  assert.equal(JSON.parse(text).root, '../projects');
  const { manifest, rootDir } = readManifest(out);
  assert.equal(rootDir, dir);
  assert.equal(serializeManifest(manifest), text);
  assert.equal(manifest.hash, manifestHash(manifest.files));

  const bad = JSON.parse(text);
  bad.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => parseManifest(JSON.stringify(bad)), /does not match/);

  appendFileSync(join(dir, '-tmp-proj-beta', 'sess-0002.jsonl'), '{"more":1}\n');
  assert.deepEqual(verifyManifest(manifest, rootDir).changed, ['-tmp-proj-beta/sess-0002.jsonl']);
});

// --- cli and paths ---

const cli = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'eval', 'cli.ts'), ...args], { encoding: 'utf8', env });

test('cli: subcommands come from scripts/eval/commands; unknown is usage on stderr and exit 2', () => {
  assert.ok(listCommands().includes('snapshot') && listCommands().includes('observe'));
  const unknown = cli(['nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown subcommand "nope"[\s\S]*snapshot/);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /observe[\s\S]*snapshot/);
});
