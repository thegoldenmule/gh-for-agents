#!/usr/bin/env node
// pnpm build:bin [--target <os-arch>|all ...] [--test-hooks]: bun build --compile ghx into
// dist-bin/ghx-<os>-<arch> (default: this machine). Needs Bun; nothing else in the repo does.
// --test-hooks bundles test/helpers/bin-entry.ts (`ghx test …` under GHX_TEST_HOOKS=1) into
// dist-bin/ghx-<os>-<arch>-test-hooks, for GHX_TEST_BIN=<path> pnpm test:contract (test/helpers/spawn.ts);
// never publish it. A release build fails if it contains test-command text.
// macOS: bun's ad-hoc signature fails `codesign -v` once the bundle is appended, so darwin outputs are
// re-signed ad hoc; that needs macOS, so darwin targets are refused elsewhere. x64 builds use Bun's -baseline
// runtime (no AVX2 needed), so older x86-64 CPUs can run them; the output name stays ghx-<os>-x64.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist-bin');
const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const;
type Target = (typeof TARGETS)[number];
/** Text only the test-only commands carry (their summaries): a release binary must not contain it. */
const TEST_MARKER = 'Test only:';

function fail(message: string): never {
  process.stderr.write(`build:bin: ${message}\n`);
  process.exit(1);
}

function hostTarget(): Target {
  const t = `${process.platform}-${process.arch}`;
  if (!(TARGETS as readonly string[]).includes(t)) fail(`no standalone binary for this platform (${t}).`);
  return t as Target;
}

function parseArgs(argv: readonly string[]): { targets: Target[]; testHooks: boolean } {
  const targets = new Set<Target>();
  let testHooks = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test-hooks') testHooks = true;
    else if (a === '--target' || a?.startsWith('--target=')) {
      const v = a === '--target' ? argv[++i] : a.slice('--target='.length);
      if (v === 'all') for (const t of TARGETS) targets.add(t);
      else if (v && (TARGETS as readonly string[]).includes(v)) targets.add(v as Target);
      else fail(`unknown --target ${v ?? '(missing)'}; use one of ${TARGETS.join(', ')}, or all.`);
    } else fail(`unknown argument ${a}. Usage: build-bin.ts [--target <os-arch>|all ...] [--test-hooks]`);
  }
  return { targets: targets.size > 0 ? [...targets] : [hostTarget()], testHooks };
}

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (cmd === 'bun') fail('bun is not on PATH. Install Bun (https://bun.sh) to build the standalone binaries.');
      fail(`${cmd} is not on PATH.`);
    }
    throw r.error;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function must(cmd: string, args: string[]): string {
  const r = run(cmd, args);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

function main(): void {
  const { targets, testHooks } = parseArgs(process.argv.slice(2));
  const darwin = targets.filter((t) => t.startsWith('darwin-'));
  if (darwin.length > 0 && process.platform !== 'darwin') {
    fail(`${darwin.join(', ')}: macOS executables must be built on macOS, which re-signs them (codesign).`);
  }
  const bun = must('bun', ['--version']).trim();
  const stale = run(process.execPath, [join(ROOT, 'scripts', 'codegen.ts'), '--check']);
  if (stale.status !== 0) fail(`${stale.stdout.trim()} (the binary would miss them)`);
  const entry = testHooks ? 'test/helpers/bin-entry.ts' : 'src/main.ts';
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  mkdirSync(OUT, { recursive: true });

  for (const target of targets) {
    const out = join(OUT, `ghx-${target}${testHooks ? '-test-hooks' : ''}`);
    const bunTarget = `bun-${target}${target.endsWith('-x64') ? '-baseline' : ''}`;
    must('bun', ['build', entry, '--compile', '--minify', `--target=${bunTarget}`, '--outfile', out]);
    if (target.startsWith('darwin-')) {
      must('codesign', ['--force', '--sign', '-', out]);
      must('codesign', ['--verify', '--strict', out]);
    }
    const hasTestCommands = readFileSync(out).includes(TEST_MARKER);
    if (hasTestCommands !== testHooks) {
      fail(`${out} ${testHooks ? 'lacks' : 'contains'} the test-only commands ('${TEST_MARKER}').`);
    }
    let smoke = '';
    if (target === `${process.platform}-${process.arch}`) {
      const v = JSON.parse(must(out, ['version'])) as { version?: string; runtime?: { standalone?: boolean } };
      if (v.version !== version || v.runtime?.standalone !== true) fail(`${out} version printed ${JSON.stringify(v)}`);
      smoke = ', runs';
    }
    const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
    process.stdout.write(`${out} (${mb} MB, bun ${bun}${target.startsWith('darwin-') ? ', signed' : ''}${smoke})\n`);
  }
}

main();
