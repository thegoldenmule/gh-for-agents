#!/usr/bin/env node
// ghx-eval (plan 07): `pnpm eval <subcommand> [args]`. Subcommands are discovered by file convention, so a
// new one never touches this file: `<name>` loads scripts/eval/commands/<name>.ts, which must export
// `run(argv: string[]): Promise<number>` (the exit code) and may export `summary: string` for --help.
// Importing a command module must have no side effects. Unknown subcommand: usage on stderr, exit 2.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const COMMANDS = join(import.meta.dirname, 'commands');

interface CommandModule {
  run?: (argv: string[]) => Promise<number>;
  summary?: string;
}

export function listCommands(dir: string = COMMANDS): string[] {
  return readdirSync(dir)
    .filter((f) => /^[a-z][a-z0-9-]*\.ts$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort();
}

async function load(name: string, dir: string): Promise<CommandModule> {
  return (await import(pathToFileURL(join(dir, `${name}.ts`)).href)) as CommandModule;
}

async function usage(dir: string): Promise<string> {
  const lines = ['Usage: pnpm eval <subcommand> [args]   (<subcommand> --help for its flags)', '', 'Subcommands:'];
  for (const name of listCommands(dir)) {
    const { summary } = await load(name, dir);
    lines.push(`  ${name.padEnd(10)} ${summary ?? ''}`.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv: string[], dir: string = COMMANDS): Promise<number> {
  const [name, ...rest] = argv;
  if (name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(await usage(dir));
    return 0;
  }
  if (name === undefined || !listCommands(dir).includes(name)) {
    if (name !== undefined) process.stderr.write(`ghx-eval: unknown subcommand ${JSON.stringify(name)}\n`);
    process.stderr.write(await usage(dir));
    return 2;
  }
  const mod = await load(name, dir);
  if (typeof mod.run !== 'function') {
    process.stderr.write(`ghx-eval: commands/${name}.ts does not export run(argv)\n`);
    return 1;
  }
  try {
    return await mod.run(rest);
  } catch (e) {
    process.stderr.write(`ghx-eval ${name}: ${(e as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
