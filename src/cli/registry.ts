// The command registry: directory-based discovery, deterministic.
//
// Extension point: a command is ONE new file, src/commands/<group>/<verb>.ts (or src/commands/<name>.ts),
// whose default export is a defineCommand/defineStreamCommand spec with `name` equal to its path
// segments. Files and directories whose names start with `_` are helpers and are never treated as
// commands. `pnpm codegen` writes the file layout into src/cli/commands.generated.ts (static lazy
// imports, so `bun build --compile` bundles every command); `pnpm codegen:check`, part of `pnpm check`,
// fails when it is stale. test/registry.test.ts proves the registry is complete.
//
// Resolution finds the longest positional prefix and imports only that one module, so a normal
// invocation loads one command. list() imports everything (help, schema, tests).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnyCommandSpec } from '../core/command.ts';
import { GhxError } from '../core/errors.ts';

export const MAX_NAME_DEPTH = 3;
const SEGMENT = /^[a-z][a-z0-9-]*$/;
/** `.ts` when running from source, `.js` from a build. */
export const MODULE_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

export interface Resolved {
  spec: AnyCommandSpec;
  /** How many leading tokens were the command name. */
  consumed: number;
}

export interface Registry {
  resolve(tokens: readonly string[]): Promise<Resolved | undefined>;
  /** Command names from the file layout, without importing anything (for "did you mean"). */
  names(): Promise<string[][]>;
  /** Every spec, sorted by name. */
  list(): Promise<AnyCommandSpec[]>;
}

export function isCommandSegment(s: string): boolean {
  return SEGMENT.test(s);
}

function isSpec(v: unknown): v is AnyCommandSpec {
  const s = v as Partial<AnyCommandSpec> | null;
  return (
    !!s &&
    typeof s === 'object' &&
    Array.isArray(s.name) &&
    (s.mode === 'single' || s.mode === 'stream') &&
    typeof s.run === 'function'
  );
}

/** One command of a generated list: its name and a static lazy import of its module. */
export interface CommandEntry {
  name: readonly string[];
  load: () => Promise<{ default?: unknown }>;
}

async function loadSpec(file: string, expected: readonly string[]): Promise<AnyCommandSpec> {
  return checkSpec((await import(pathToFileURL(file).href)) as { default?: unknown }, file, expected);
}

function checkSpec(mod: { default?: unknown }, file: string, expected: readonly string[]): AnyCommandSpec {
  if (!isSpec(mod.default)) {
    throw new GhxError('INTERNAL', `${file} does not default-export a command spec.`);
  }
  const spec = mod.default;
  if (spec.name.join(' ') !== expected.join(' ')) {
    throw new GhxError(
      'INTERNAL',
      `${file} declares name '${spec.name.join(' ')}' but its path says '${expected.join(' ')}'.`,
    );
  }
  return spec;
}

/** Every command file under `root` as name segments, sorted. Helper (`_`) and non-module files are skipped. */
export function scanCommandFiles(root: string, ext = MODULE_EXT): { file: string; name: string[] }[] {
  const out: { file: string; name: string[] }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_NAME_DEPTH) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(ext) && !e.name.endsWith(`.d${ext}`)) {
        const segs = relative(root, p).slice(0, -ext.length).split(sep);
        if (segs.every(isCommandSegment)) out.push({ file: p, name: segs });
      }
    }
  };
  if (existsSync(root)) walk(root, 1);
  return out.sort((a, b) => a.name.join(' ').localeCompare(b.name.join(' ')));
}

export function fsRegistry(roots: readonly string[], ext = MODULE_EXT): Registry {
  const cache = new Map<string, Promise<AnyCommandSpec>>();
  const load = (file: string, name: readonly string[]): Promise<AnyCommandSpec> => {
    let p = cache.get(file);
    if (!p) {
      p = loadSpec(file, name);
      cache.set(file, p);
    }
    return p;
  };
  return {
    async resolve(tokens) {
      for (let k = Math.min(tokens.length, MAX_NAME_DEPTH); k >= 1; k--) {
        const segs = tokens.slice(0, k);
        if (!segs.every(isCommandSegment)) continue;
        for (const root of roots) {
          const file = `${join(root, ...segs)}${ext}`;
          if (existsSync(file) && statSync(file).isFile()) return { spec: await load(file, segs), consumed: k };
        }
      }
      return undefined;
    },
    async names() {
      return roots.flatMap((r) => scanCommandFiles(r, ext).map((c) => c.name));
    },
    async list() {
      const specs = await Promise.all(roots.flatMap((r) => scanCommandFiles(r, ext).map((c) => load(c.file, c.name))));
      return specs.sort((a, b) => a.name.join(' ').localeCompare(b.name.join(' ')));
    },
  };
}

/** A registry over explicit specs (tests: the `_tick` stream command, forced contract bugs). */
export function staticRegistry(specs: readonly AnyCommandSpec[]): Registry {
  const sorted = [...specs].sort((a, b) => a.name.join(' ').localeCompare(b.name.join(' ')));
  return {
    async resolve(tokens) {
      for (let k = Math.min(tokens.length, MAX_NAME_DEPTH); k >= 1; k--) {
        const key = tokens.slice(0, k).join(' ');
        const spec = sorted.find((s) => s.name.join(' ') === key);
        if (spec) return { spec, consumed: k };
      }
      return undefined;
    },
    async names() {
      return sorted.map((s) => [...s.name]);
    },
    async list() {
      return sorted;
    },
  };
}

/** A registry over a generated list of lazy imports: resolving a name loads only that module. */
export function lazyRegistry(entries: readonly CommandEntry[]): Registry {
  const sorted = [...entries].sort((a, b) => a.name.join(' ').localeCompare(b.name.join(' ')));
  const cache = new Map<CommandEntry, Promise<AnyCommandSpec>>();
  const load = (e: CommandEntry): Promise<AnyCommandSpec> => {
    let p = cache.get(e);
    if (!p) {
      p = e.load().then((mod) => checkSpec(mod, e.name.join('/'), e.name));
      cache.set(e, p);
    }
    return p;
  };
  return {
    async resolve(tokens) {
      for (let k = Math.min(tokens.length, MAX_NAME_DEPTH); k >= 1; k--) {
        const key = tokens.slice(0, k).join(' ');
        const entry = sorted.find((e) => e.name.join(' ') === key);
        if (entry) return { spec: await load(entry), consumed: k };
      }
      return undefined;
    },
    async names() {
      return sorted.map((e) => [...e.name]);
    },
    async list() {
      return Promise.all(sorted.map(load));
    },
  };
}

/** First registry that resolves wins; listings are merged and sorted. */
export function combineRegistries(...regs: readonly Registry[]): Registry {
  return {
    async resolve(tokens) {
      let best: Resolved | undefined;
      for (const r of regs) {
        const hit = await r.resolve(tokens);
        if (hit && (!best || hit.consumed > best.consumed)) best = hit;
      }
      return best;
    },
    async names() {
      return (await Promise.all(regs.map((r) => r.names())))
        .flat()
        .sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
    },
    async list() {
      return (await Promise.all(regs.map((r) => r.list())))
        .flat()
        .sort((a, b) => a.name.join(' ').localeCompare(b.name.join(' ')));
    },
  };
}

/** The test-only command root of a checkout (test/helpers/commands), only when GHX_TEST_HOOKS=1. */
export function testCommandRoots(env: Readonly<Record<string, string | undefined>>, srcDir: string): string[] {
  if (env.GHX_TEST_HOOKS !== '1') return [];
  const testRoot = join(srcDir, '..', 'test', 'helpers', 'commands');
  return existsSync(testRoot) ? [testRoot] : [];
}
