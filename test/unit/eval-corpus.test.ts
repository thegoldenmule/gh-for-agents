// ghx-eval M0 (plan 07): the JSONL reader, manifests, snapshots and incremental ingest, over the hand-built
// corpus in test/fixtures/eval/corpus and temp copies of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { listCommands } from '../../scripts/eval/cli.ts';
import { ingest, readState } from '../../scripts/eval/corpus/ingest.ts';
import {
  comparePaths,
  manifestHash,
  parseManifest,
  readManifest,
  serializeManifest,
  verifyManifest,
  writeManifest,
} from '../../scripts/eval/corpus/manifest.ts';
import { defaultStore, evalHome, storeLayout } from '../../scripts/eval/corpus/paths.ts';
import {
  lastNewlineOffset,
  parseJsonl,
  readJsonl,
  readJsonlAll,
  readJsonlSync,
} from '../../scripts/eval/corpus/read.ts';
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
  assert.equal(lastNewlineOffset(MAIN), lastNl);
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

// --- ingest ---

function storeFiles(store: string): string[] {
  return walkCorpus(storeLayout(store).files).files.map((w) => w.path);
}

test('ingest: new files copied up to the last newline with the source mtime; unmatched counted, not copied', () => {
  const src = corpusCopy(new Date('2026-10-01T00:00:00Z'));
  const store = join(temp(), 'store');
  const run = ingest({ source: src, store, now: FUTURE, label: 'first' });
  assert.deepEqual(
    { ...run.counts, bytesAdded: 0 },
    { new: 6, grown: 0, unchanged: 0, divergent: 0, pending: 0, unmatched: 5, bytesAdded: 0 },
  );
  const copied = join(storeLayout(store).files, '-tmp-proj-alpha', 'sess-0001.jsonl');
  assert.equal(statSync(copied).size, lastNewlineOffset(MAIN));
  assert.equal(statSync(copied).mtime.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(storeFiles(store).length, 6);
  assert.equal(readState(store).runs[0]!.label, 'first');

  const again = ingest({ source: src, store, now: FUTURE });
  assert.deepEqual([again.counts.new, again.counts.unchanged, again.counts.bytesAdded], [0, 6, 0]);
});

test('ingest: grown files get the appended bytes; new and pending files are handled', () => {
  const src = corpusCopy(new Date('2026-10-01T00:00:00Z'));
  const store = join(temp(), 'store');
  ingest({ source: src, store, now: FUTURE });
  const live = join(src, '-tmp-proj-alpha', 'sess-0001.jsonl');
  appendFileSync(live, '0Z"}\n{"type":"user","uuid":"u-0005"}\n{"partial');
  mkdirSync(join(src, '-tmp-proj-gamma'));
  writeFileSync(join(src, '-tmp-proj-gamma', 'sess-0003.jsonl'), '{"type":"user"}\n');
  writeFileSync(join(src, '-tmp-proj-gamma', 'sess-0004.jsonl'), '{"no newline yet"');

  const run = ingest({ source: src, store, now: FUTURE });
  assert.deepEqual(
    [run.counts.new, run.counts.grown, run.counts.unchanged, run.counts.pending, run.counts.divergent],
    [1, 1, 5, 1, 0],
  );
  const stored = readFileSync(join(storeLayout(store).files, '-tmp-proj-alpha', 'sess-0001.jsonl'));
  const source = readFileSync(live);
  assert.deepEqual(stored, source.subarray(0, source.lastIndexOf(0x0a) + 1));
  assert.equal(
    snapshot({ root: storeLayout(store).files, now: FUTURE }).files.find(
      (f) => f.path === '-tmp-proj-alpha/sess-0001.jsonl',
    )?.size,
    stored.length,
  );
  assert.ok(!storeFiles(store).includes('-tmp-proj-gamma/sess-0004.jsonl'));
});

test('ingest: a shrunk, rewritten or deleted source never changes the store; the new version is recorded', () => {
  const src = corpusCopy(new Date('2026-10-01T00:00:00Z'));
  const store = join(temp(), 'store');
  ingest({ source: src, store, now: FUTURE });
  const before = snapshot({ root: storeLayout(store).files, now: FUTURE });

  const shrunk = join(src, '-tmp-proj-beta', 'sess-0002.jsonl');
  truncateSync(shrunk, 0);
  writeFileSync(shrunk, '{"a":1}\n');
  const meta = join(src, '-tmp-proj-alpha', 'sess-0001', 'subagents', 'agent-a0001.meta.json');
  const rewritten = readFileSync(meta, 'utf8').replace('foreground', 'background');
  writeFileSync(meta, rewritten);
  rmSync(join(src, '-tmp-proj-alpha', 'sess-0001', 'subagents', 'agent-a0002.forked-skill.json'));

  const run = ingest({ source: src, store, now: FUTURE });
  assert.equal(run.counts.divergent, 2);
  assert.equal(snapshot({ root: storeLayout(store).files, now: FUTURE }).hash, before.hash, 'store unchanged');
  const div = readState(store).divergent;
  assert.deepEqual(
    div.map((d) => [d.path, d.kind]),
    [
      ['-tmp-proj-alpha/sess-0001/subagents/agent-a0001.meta.json', 'rewritten'],
      ['-tmp-proj-beta/sess-0002.jsonl', 'shrunk'],
    ],
  );
  assert.equal(readFileSync(join(store, div[0]!.savedAs), 'utf8'), rewritten);

  const rerun = ingest({ source: src, store, now: FUTURE });
  assert.equal(rerun.counts.divergent, 2);
  assert.equal(readState(store).divergent.length, 2, 'the same divergent version is recorded once');
});

test('ingest: a lost state.json is rebuilt from the store files', () => {
  const src = corpusCopy(new Date('2026-10-01T00:00:00Z'));
  const store = join(temp(), 'store');
  ingest({ source: src, store, now: FUTURE });
  rmSync(storeLayout(store).state);
  const run = ingest({ source: src, store, now: FUTURE });
  assert.deepEqual([run.counts.new, run.counts.unchanged, run.counts.divergent], [0, 6, 0]);
});

test('ingest: a tar.gz archive imports like its directory and leaves no staging behind', () => {
  const src = corpusCopy(new Date('2026-10-01T00:00:00Z'));
  const tarball = join(temp(), 'projects.tar.gz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', src, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.equal(tar.status, 0, String(tar.stderr));
  const store = join(temp(), 'store');
  const run = ingest({ source: tarball, store, now: FUTURE });
  assert.equal(run.kind, 'archive');
  assert.equal(run.counts.new, 6);
  assert.deepEqual(readdirSync(store).sort(), ['files', 'state.json']);
  const fromDir = join(temp(), 'store');
  ingest({ source: src, store: fromDir, now: FUTURE });
  assert.equal(
    snapshot({ root: storeLayout(store).files, now: FUTURE }).hash,
    snapshot({ root: storeLayout(fromDir).files, now: FUTURE }).hash,
  );
  assert.ok(existsSync(tarball), 'the archive is left in place');
});

// --- cli and paths ---

const cli = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'eval', 'cli.ts'), ...args], { encoding: 'utf8', env });

test('cli: subcommands come from scripts/eval/commands; unknown is usage on stderr and exit 2', () => {
  assert.ok(listCommands().includes('snapshot') && listCommands().includes('ingest'));
  const unknown = cli(['nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown subcommand "nope"[\s\S]*snapshot/);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ingest[\s\S]*snapshot/);
});

test('cli: ingest into GHX_EVAL_HOME, then snapshot --store reproduces the store manifest hash', () => {
  const src = corpusCopy(new Date('2026-10-01T00:00:00Z'));
  const home = temp();
  const env = { ...process.env, GHX_EVAL_HOME: home };
  assert.equal(defaultStore(env), join(home, 'corpus'));
  assert.equal(evalHome({}), join(process.env.HOME ?? '', '.ghx-eval'));
  const now = '2026-10-29T12:00:00.000Z';
  const ing = cli(['ingest', '--from', src, '--now', now], env);
  assert.equal(ing.status, 0, ing.stderr);
  const summary = JSON.parse(ing.stdout);
  assert.equal(summary.manifest.path, join(home, 'corpus', 'manifests', '20261029T120000Z.json'));
  const snap = cli(['snapshot', '--store', join(home, 'corpus'), '--now', now, '--out', join(home, 'again.json')], env);
  assert.equal(snap.status, 0, snap.stderr);
  assert.equal(JSON.parse(snap.stdout).hash, summary.manifest.hash);
  assert.equal(readManifest(summary.manifest.path).manifest.hash, summary.manifest.hash);
});
