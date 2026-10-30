// runCli(argv, deps): global flags, route, dispatch. Never throws: every failure is an error document.
import { type AnyCommandSpec, commandName } from '../core/command.ts';
import { GhxError } from '../core/errors.ts';
import { ExitCode } from '../core/exit.ts';
import {
  emitDocument,
  emitError,
  type OutputOptions,
  outputOptions,
  type RunDeps,
  type RunOutcome,
  runCommand,
  runCommandWith,
} from '../core/runner.ts';
import { suggest } from '../core/suggest.ts';
import { ALLOWED_NAMES, API_USAGE } from '../passthrough/policy.ts';
import { deriveInterface, parseCommandArgv } from './args.ts';
import { commandHelp, globalHelp, groupHelp } from './help.ts';
import type { Registry } from './registry.ts';
import { allSchemas, commandSchema, cwdConfig, SCHEMA_TARGETS, schemaIndex } from './schema.ts';
import { onUnknown as defaultOnUnknown, type UnknownContext, type UnknownResult } from './unknown.ts';

export interface CliDeps extends RunDeps {
  registry: Registry;
  version: string;
  onUnknown?: (tokens: readonly string[], ctx: UnknownContext) => Promise<UnknownResult>;
}

const done = (exitCode: number): RunOutcome => ({ exitCode, forced: false });

/** Schema output is documentation, so it is never spilled (final review decisions); errors stay bounded. */
const unbounded = (o: OutputOptions): OutputOptions => ({ ...o, maxBytes: Number.POSITIVE_INFINITY });

/** A --help or -h before any `--`. */
function wantsHelp(argv: readonly string[]): boolean {
  const dd = argv.indexOf('--');
  return (dd === -1 ? argv : argv.slice(0, dd)).some((t) => t === '--help' || t === '-h');
}

function leadingWords(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of argv) {
    if (t.startsWith('-')) break;
    out.push(t);
  }
  return out;
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<RunOutcome> {
  let out = outputOptions({}, deps, 'ghx');
  try {
    const words = leadingWords(argv);
    const first = argv[0];

    // ghx, ghx --help, ghx -h, ghx help [command…]
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      const rest = first === 'help' ? argv.slice(1) : argv.slice(1);
      const g = parseCommandArgv(
        rest.filter((t) => t.startsWith('-')),
        undefined,
        undefined,
      ).globals;
      out = outputOptions(g, deps, 'help');
      const targetWords = first === 'help' ? leadingWords(argv.slice(1)) : [];
      if (targetWords.length > 0) {
        const hit = await deps.registry.resolve(targetWords);
        const group =
          !hit && targetWords.length === 1
            ? groupHelp(targetWords[0] as string, await deps.registry.list())
            : undefined;
        if (group) {
          await emitDocument(deps.stdout, group, out);
          return done(ExitCode.OK);
        }
        if (!hit) return done(await refuseUnknown(targetWords, deps, out));
        await emitDocument(deps.stdout, commandHelp(hit.spec), out);
        return done(ExitCode.OK);
      }
      await emitDocument(deps.stdout, globalHelp(await deps.registry.list(), deps.version), out);
      return done(ExitCode.OK);
    }

    if (first === '--version') return runCli(['version', ...argv.slice(1)], deps);

    if (first === 'schema') {
      const parsed = parseCommandArgv(
        argv.slice(1).filter((t) => t !== '--all'),
        undefined,
        undefined,
      );
      out = outputOptions(parsed.globals, deps, 'schema');
      const all = argv.includes('--all');
      // `ghx schema "pr create"` arrives as one token; a target is its words either way.
      const target = parsed.positionals.flatMap((t) => t.split(/\s+/).filter((w) => w !== ''));
      if (all) {
        const content = JSON.stringify(allSchemas(await deps.registry.list()), null, 2);
        const ref = await out.artifacts.write({
          kind: 'schema',
          name: `ghx-${deps.version}-all.json`,
          content: `${content}\n`,
        });
        await emitDocument(deps.stdout, { path: ref.path, bytes: ref.bytes }, out);
        return done(ExitCode.OK);
      }
      if (target.length === 0) {
        await emitDocument(deps.stdout, schemaIndex(await deps.registry.list()), unbounded(out));
        return done(ExitCode.OK);
      }
      const t = target.join(' ');
      const builtin = SCHEMA_TARGETS[t];
      if (builtin) {
        await emitDocument(deps.stdout, builtin.build(), unbounded(out));
        return done(ExitCode.OK);
      }
      const hit = await deps.registry.resolve(target);
      if (hit && hit.consumed === target.length) {
        await emitDocument(deps.stdout, commandSchema(hit.spec, { config: cwdConfig(deps.cwd) }), unbounded(out));
        return done(ExitCode.OK);
      }
      const names = [...Object.keys(SCHEMA_TARGETS), ...(await deps.registry.names()).map((n) => n.join(' '))];
      const suggestions = suggest(t, names);
      throw new GhxError('USAGE_UNKNOWN_COMMAND', `'${t}' is not a schema target.`, {
        hint:
          suggestions.length > 0
            ? `Did you mean: ${suggestions.map((n) => `ghx schema ${n}`).join(', ')}?`
            : 'Run ghx schema to list targets.',
        details: { suggestions },
      });
    }

    const hit = words.length > 0 ? await deps.registry.resolve(words) : undefined;
    // `ghx api --help`: gh's own help cannot pass the GET check, so it gets passthrough help (02 §10).
    if (!hit && words[0] === 'api' && wantsHelp(argv)) return done(await refuseUnknown(['api'], deps, out));
    // `ghx ci --help` or a bare `ghx ci`: the group's commands.
    if (!hit && words.length === 1 && (argv.length === 1 || wantsHelp(argv))) {
      const group = groupHelp(words[0] as string, await deps.registry.list());
      if (group) {
        out = outputOptions(parseCommandArgv(argv.slice(1), undefined, undefined).globals, deps, 'help');
        await emitDocument(deps.stdout, group, out);
        return done(ExitCode.OK);
      }
    }
    if (!hit) {
      const handler = deps.onUnknown ?? defaultOnUnknown;
      const r = await handler(argv, {
        names: await deps.registry.names(),
        resolve: (t) => deps.registry.resolve(t),
      });
      if (r.kind === 'refuse') return done(await emitError(deps.stdout, r.error, out, deps.clock));
      return runCommandWith(r.spec, r.globals ?? {}, deps, async () => r.input);
    }

    const spec = hit.spec;
    const rest = argv.slice(hit.consumed);
    if (spec.protocol && !rest.some((t) => t === '--help' || t === '-h' || t === '--schema')) {
      return await runProtocol(spec.protocol, deps);
    }
    const parsed = parseCommandArgv(rest, spec, deriveInterface(spec));
    out = outputOptions(parsed.globals, deps, commandName(spec));
    if (parsed.globals.help) {
      await emitDocument(deps.stdout, commandHelp(spec), out);
      return done(ExitCode.OK);
    }
    if (parsed.globals.schema) {
      await emitDocument(deps.stdout, commandSchema(spec, { config: cwdConfig(deps.cwd) }), unbounded(out));
      return done(ExitCode.OK);
    }
    return await runCommand(spec, parsed, deps);
  } catch (e) {
    return done(await emitError(deps.stdout, e, out, deps.clock));
  }
}

const PROTOCOL_MAX_STDIN = 1_048_576;
const PROTOCOL_STDIN_MS = 2_000;

/** A harness protocol (spec.protocol): fail open, so every path ends in exit 0, with output or without. */
async function runProtocol(protocol: NonNullable<AnyCommandSpec['protocol']>, deps: CliDeps): Promise<RunOutcome> {
  const giveUp = new AbortController();
  try {
    deps.clock.sleep(PROTOCOL_STDIN_MS, giveUp.signal).then(
      () => giveUp.abort(),
      () => {},
    );
    const stdin = await deps.readStdin(PROTOCOL_MAX_STDIN, giveUp.signal);
    giveUp.abort();
    const reply = protocol(stdin, deps.env, deps.clock);
    if (reply !== null) await deps.stdout.writeLine(reply);
  } catch {
    // Fail open: no output.
  } finally {
    giveUp.abort();
  }
  return done(ExitCode.OK);
}

async function refuseUnknown(
  words: readonly string[],
  deps: CliDeps,
  out: ReturnType<typeof outputOptions>,
): Promise<number> {
  const r = await (deps.onUnknown ?? defaultOnUnknown)(words, { names: await deps.registry.names() });
  // An allowlisted gh read (02 §10; bare `api` has no endpoint to check yet): say how it runs.
  if (r.kind === 'run' || ALLOWED_NAMES.includes(words.join(' '))) {
    const name = r.kind === 'run' ? r.spec.name.join(' ') : words.join(' ');
    await emitDocument(
      deps.stdout,
      {
        name,
        passthrough: true,
        summary: `Not a ghx command: ghx ${name} runs gh ${name} through passthrough, an allowlisted gh read.`,
        usage:
          name === 'api'
            ? `${API_USAGE}; GET only, so no -X, -f/-F, --input or graphql; {owner}/{repo} in the endpoint is filled from the resolved repo`
            : `ghx ${name} [gh flags and arguments]; see gh ${name} --help for them`,
        output: '{passthrough:{argv, exitCode, json?, text?, stdoutPath?, stdoutBytes, stderr?}}',
        fields: '--fields passthrough.json.<key> keeps parts of the envelope (ghx takes it; gh never sees it)',
      },
      out,
    );
    return ExitCode.OK;
  }
  return emitError(deps.stdout, r.error, out, deps.clock);
}
