// The command registry: directory-based discovery, deterministic and build-free.
//
// Extension point: a command is ONE new file, src/commands/<group>/<verb>.ts (or src/commands/<name>.ts),
// whose default export is a defineCommand/defineStreamCommand spec with `name` equal to its path
// segments. No central file is edited. Files and directories whose names start with `_` are helpers
// and are never treated as commands. test/registry.test.ts proves the registry is complete.
//
// Resolution stats candidate paths for the longest positional prefix and imports only that one
// module, so a normal invocation loads one command. list() imports everything (help, schema, tests).
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

async function loadSpec(file: string, expected: readonly string[]): Promise<AnyCommandSpec> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
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

/** The production command roots: src/commands, plus test/helpers/commands when GHX_TEST_HOOKS=1. */
export function commandRoots(env: Readonly<Record<string, string | undefined>>, srcDir: string): string[] {
  const roots = [join(srcDir, 'commands')];
  if (env.GHX_TEST_HOOKS === '1') {
    const testRoot = join(srcDir, '..', 'test', 'helpers', 'commands');
    if (existsSync(testRoot)) roots.push(testRoot);
  }
  return roots;
}
