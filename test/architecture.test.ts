// Grep guards for rules Biome can't express (01 §3.8, 03 §1 row 13). Comments are ignored.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [],
  );
}

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

const files = walk(SRC).map((f) => ({ rel: relative(ROOT, f), text: code(f) }));

interface Rule {
  name: string;
  pattern: RegExp;
  allowed: (rel: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: 'real timers only in src/core/clock.ts',
    pattern: /\bsetTimeout\(|\bsetInterval\(|\bDate\.now\(|\bperformance\.now\(|timers\/promises/,
    allowed: (f) => f === 'src/core/clock.ts',
  },
  {
    name: 'process.exit only in src/core/signals.ts',
    pattern: /\bprocess\.exit\(/,
    allowed: (f) => f === 'src/core/signals.ts',
  },
  {
    name: 'randomness only in src/core/random.ts',
    pattern: /\bMath\.random\b|\brandomUUID\b|\brandomBytes\b/,
    allowed: (f) => f === 'src/core/random.ts',
  },
  {
    name: 'process I/O, env and argv only in src/main.ts (handlers read ctx.env)',
    pattern: /\bprocess\.(env|stdout|stderr|stdin|argv|on|once|off|cwd|exitCode)\b/,
    allowed: (f) => f === 'src/main.ts',
  },
  {
    name: 'child_process only in src/proc/**',
    pattern: /from ['"](node:)?child_process['"]/,
    allowed: (f) => f.startsWith('src/proc/'),
  },
  { name: 'no console.* in src', pattern: /\bconsole\./, allowed: () => false },
];

for (const rule of RULES) {
  test(rule.name, () => {
    const offenders = files.filter((f) => rule.pattern.test(f.text) && !rule.allowed(f.rel)).map((f) => f.rel);
    assert.deepEqual(offenders, []);
  });
}

test('the guards actually match what they ban', () => {
  const sample = 'setTimeout(f); Date.now(); process.exit(1); Math.random(); process.env.X; console.log(1)';
  for (const rule of RULES.filter((r) => !r.name.startsWith('child_process'))) {
    assert.ok(rule.pattern.test(sample), rule.name);
  }
});
