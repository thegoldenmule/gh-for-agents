# 01: Scaffolding plan for `ghx`

Status: draft. Inputs: `docs/plans/00-brief.md` (pinned) and `docs/research/gh-usage-findings.md` (cited as §N). This plan defines the skeleton that commands plug into. Command semantics belong to `docs/plans/02-api.md`. Wherever the two meet, this plan says "02-api owns X; the skeleton exposes Y".

Environment checked on 2026-10-22: Node v24.13.0, gh 2.86.0, pnpm 12.5.1. On npm, `latest` is zod 4.6.7, typescript 7.0.2, @biomejs/biome 2.6.2 and @types/node@24 24.19.2. Two sibling precedents exist. `static-x` (the same author's "tools for LLMs" CLI) uses npm, vitest, a tsx loader shim, `node:util.parseArgs` and a `CliIo` seam. `powerhouse`, the main repo in the corpus (§1), uses pnpm (`ERR_PNPM` appears in §5.1).

---

## 1. Repo layout

```
package.json              name "ghx", private, type module, bin {ghx: bin/ghx.js}, engines node >=24
pnpm-lock.yaml
.node-version             24
tsconfig.json             strict typecheck of src/test/bin, noEmit
tsconfig.build.json       emit to dist/ (unused in v1; kept so a publish only needs one command)
biome.json                lint and format; restricted imports and console (see §2)
.gitignore                node_modules, dist, coverage
.github/workflows/ci.yml  typecheck, lint and test on ubuntu-latest and macos-latest, Node 24
.github/ghx.json          dogfood config for this repo (see §5)

bin/ghx.js                shebang shim: enables compile cache, imports ../src/main.ts
src/main.ts               the only place that touches process: builds real deps, calls runCli(), sets exitCode

src/cli/
  run.ts                  runCli(argv, deps): global flags, route, dispatch; never throws
  router.ts               command registry lookup (longest positional prefix), "did you mean", onUnknown hook
  args.ts                 JSON Schema to parseArgs options; argv + --input file/stdin to raw input object
  help.ts                 JSON help (global and per command), built from the registry
  schema.ts               `--schema` and `ghx schema [target]` via z.toJSONSchema

src/core/
  command.ts              defineCommand / defineStreamCommand, CommandSpec types, Context type
  context.ts              builds Context: lazy repo, lazy config, mode-guarded gh, artifacts
  runner.ts               single-mode runner: validate in, deadline, run, validate out, emit, exit code
  stream.ts               stream runner: iterate generator, validate events, heartbeat, terminal line
  errors.ts               GhxError, ErrorCode registry, toErrorObject(), zod issue mapping
  exit.ts                 ExitCode constants (provisional; 02-api owns the table)
  output.ts               Sink (awaits stdout drain), stable JSON, size bound, spill, boundText()
  artifacts.ts            ArtifactStore: deterministic paths, write, stream-to-file, prune
  clock.ts                Clock interface, realClock
  signals.ts              SIGINT/SIGTERM/EPIPE to shutdown AbortController; grace window; 2nd-signal force
  poll.ts                 generic poll/backoff loop on Clock, rate-budget aware
  duration.ts             "90s" / "10m" / "2h" parsing
  suggest.ts              Damerau-Levenshtein "did you mean"

src/proc/
  runner.ts               ProcessRunner interface and spawn impl (timeout, abort, kill escalation, maxBuffer)

src/gh/                   the gh exec layer; the only importer of proc/runner for `gh`
  index.ts                createGh(): Gh
  env.ts                  sanitized child env (GH_PAGER= etc.)
  classify.ts             (exitCode, stderr) to GhFailure code; table-driven (§3.1)
  retry.ts                RetryPolicy, jittered backoff, honors Retry-After
  api.ts                  REST via `gh api --include`: status/headers/body parse, manual Link pagination
  graphql.ts              graphql helper, mutation detection
  ratelimit.ts            RateBudget tracker; suggestInterval()
  guard.ts                read-mode allowlist; mutation classifier for argv
  version.ts              `gh --version` parse, feature probes, MIN_GH_VERSION
  refs.ts                 parse PR/run/job refs: 123, #123, o/r#123, PR/run/job URLs
  repo.ts                 RepoRef, resolveRepo(), mismatch rules

src/git/index.ts          Git probe: toplevel, remotes, gh-resolved, current branch (via ProcessRunner)

src/config/
  schema.ts               GhxConfig zod schema (sections; 02-api adds fields)
  load.ts                 discovery for the *target* repo; local vs remote; typed errors
  starter.ts              starter config builder for `ghx init` (workspace inference)

src/meta/codec.ts         encode/decode/upsert/strip `<!-- ghx:vN {json} -->`
src/render/markdown.ts    pure helpers: inline escaping, compact trailer join, footer append

src/commands/
  index.ts                registry: explicit array of specs (no fs scanning)
  version.ts              ghx version
  doctor.ts               ghx doctor
  init.ts                 ghx init
  hook.ts                 ghx hook claude-pretooluse (optional, last)
  pr/*.ts, ci/*.ts        02-api's commands, one file per command

src/util/glob.ts          wraps path.matchesGlob (swappable for picomatch)
src/util/json.ts          stableStringify (sorted keys), parseJsonWithPosition

test/
  helpers/harness.ts      runInProcess(argv, {registry?, proc?, clock?, env?, cwd?}) to {stdout, lines, exitCode, calls}
  helpers/fake-clock.ts   FakeClock with advance()/runUntil()
  helpers/fake-proc.ts    FakeProcessRunner: scripted responses keyed by argv matcher; records calls
  helpers/stream-fixture.ts  test-only stream command (`_tick`) for runner tests
  fixtures/gh/            recorded gh outputs per scenario: {argv, exitCode, stdout, stderr}.json
  fixtures/gh-stderr/     verbatim error strings from §3.1 for classifier tests
  fixtures/bodies/        PR/comment bodies with and without ghx blocks, incl. `<!-- ci-duration-watch -->` (§8c)
  fixtures/config/        valid and invalid ghx.json samples
  fixtures/bin/gh         fake `gh` executable (node script) replaying a scenario dir, for e2e
  unit/**                 mirrors src/
  e2e/*.e2e.test.ts       spawn bin/ghx.js with PATH=test/fixtures/bin:$PATH
  registry.test.ts        generic per-spec invariants (see §3.8)
  architecture.test.ts    grep guards (no setTimeout/Date.now outside clock, etc.)

docs/agents/
  claude-md-snippet.md    paste-in block for CLAUDE.md
  skill/ghx/SKILL.md      Claude Code skill
  hooks.md                permission deny rules and PreToolUse hook setup
```

Tests live in `test/` rather than beside the source (static-x colocates them). That keeps `src/` limited to what runs, and the fixtures sit next to the tests that use them.

---

## 2. Tooling

| Concern | Choice | Why |
|---|---|---|
| Package manager | **pnpm** (`packageManager: "pnpm@12.5.1"`) | It's the user's daily tool (powerhouse, §0/§5.1 `ERR_PNPM`). Its strict `node_modules` catches phantom deps. Nothing here is pnpm-specific, so `npm` works the same. |
| Runtime deps | **`zod@^4.6.7` only** | It's pinned by the brief. zod 4 has `z.toJSONSchema` built in, so no `zod-to-json-schema` is needed. Everything else comes from Node built-ins: `util.parseArgs`, `path.matchesGlob`, `fs.glob`, `child_process`, `timers/promises`, `node:test`. |
| Dev deps | `typescript@^7.0.2`, `@types/node@^24.19.2`, `@biomejs/biome@2.6.2` (exact pin, as Biome recommends) | That makes three dev deps in total. |
| TS config | strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, **`erasableSyntaxOnly`**, **`allowImportingTsExtensions`**, **`rewriteRelativeImportExtensions`**, `module`/`moduleResolution: nodenext`, `target`/`lib: es2024`, `types: ["node"]`, `noEmit` | Matches static-x's strictness. `erasableSyntaxOnly` keeps the source runnable by Node's type stripping, which forbids enums, namespaces and parameter properties. Relative imports use `.ts`. **Fallback:** if tsc 7 rejects any of these flags, pin `typescript@~5.9.3` as static-x does. All of them exist since 5.8. |
| Build | **No build in v1.** Node 24 runs `src/**/*.ts` directly via type stripping. `bin/ghx.js` is a 4-line JS shim. | There is no stale `dist/` for agents to run after editing source, no bundler, and no tsx dep. Measured: type stripping adds about 25 ms per start (about 18 ms → 43 ms here), which is fine for a CLI. The shim calls `module.enableCompileCache()`. **Constraint:** Node refuses to strip `.ts` under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `pnpm link --global` / `npm link` resolve to the repo's realpath, so linking works. `npm i -g <tarball>` would not. So v1 is `private: true` and linked. Before any publish, `pnpm build` (tsc with `tsconfig.build.json` → `dist/`, using `rewriteRelativeImportExtensions`) and point `bin` at `dist/`. |
| Test runner | **`node:test`** (`node --test --test-reporter=spec "test/**/*.test.ts"`) | Zero deps. It runs `.ts` exactly as the bin does, so no separate transform can disagree. Time is driven by our own `Clock` (§3.6), so vitest's fake timers aren't needed. static-x uses vitest; we skip it here to avoid the vite/esbuild tree. Coverage: `--experimental-test-coverage`. |
| Lint and format | **Biome 2** | One dep covers lint and format. Rules: `recommended`, `suspicious/noConsole` (all output goes through the Sink), `style/noRestrictedImports` (`node:child_process` only in `src/proc/**`, overridden per path). Anything Biome can't express goes in `test/architecture.test.ts` (§3.8). |
| Arg parsing | **`node:util.parseArgs` plus a hand-rolled ~60-line router** | Flags are *derived from the input schema* (§3.3), so a declarative parser library (commander, yargs) would duplicate the zod schema. `parseArgs` gives strict unknown-flag errors and `allowNegative` (`--no-draft`, verified on 24.13). static-x uses the same approach. |
| Local install | `pnpm link --global` (or `npm link`) from the repo. `ghx` then resolves to `bin/ghx.js` → `src/main.ts`, and source edits take effect at once. | |
| Scripts | `typecheck: tsc -p .`, `lint: biome check .`, `format: biome format --write .`, `test: node --test "test/**/*.test.ts"`, `test:e2e: node --test "test/e2e/**/*.e2e.test.ts"`, `check: pnpm typecheck && pnpm lint && pnpm test` | |

`bin/ghx.js`:
```js
#!/usr/bin/env node
import module from 'node:module';
module.enableCompileCache?.();
await import('../src/main.ts');
```

---

## 3. Command framework

### 3.1 Declaring a command

```ts
// src/core/command.ts
import type { z } from 'zod';

export type CommandKind = 'read' | 'write';
export type RepoNeed = 'none' | 'optional' | 'inferred' | 'explicit'; // explicit: cwd inference refused
export type ConfigNeed = 'none' | 'optional' | 'required';

interface BaseSpec<I extends z.ZodObject> {
  name: readonly [string, ...string[]];          // ['pr', 'status']
  summary: string;                                // one line, shown in `ghx --help`
  description?: string;
  kind: CommandKind;
  input: I;                                       // top-level object; scalar fields become flags
  positionals?: readonly (keyof z.input<I> & string)[]; // e.g. ['pr']
  needs?: { repo?: RepoNeed; config?: ConfigNeed };
  timeout?: { defaultMs: number; maxMs: number }; // default {60_000, 300_000}
  replaces?: readonly string[];                   // e.g. ['gh pr checks', 'gh run view --log'], used by help and hook
  examples?: readonly { argv: string; note?: string }[];
}

export interface SingleCommandSpec<I extends z.ZodObject, O extends z.ZodObject> extends BaseSpec<I> {
  mode: 'single';
  output: O;
  run(input: z.output<I>, ctx: Context): Promise<z.input<O>>;
  exitCode?(output: z.output<O>): ExitCode;       // default ExitCode.OK
}

export interface StreamCommandSpec<I extends z.ZodObject, E extends z.ZodType, S extends z.ZodObject> extends BaseSpec<I> {
  mode: 'stream';
  event: E;          // discriminated union on `type`; reserved: summary|error|heartbeat|warning
  summary: S;
  heartbeatMs?: number;                           // emit heartbeat after N ms of silence
  run(input: z.output<I>, ctx: Context): AsyncGenerator<z.input<E>, z.input<S>, void>;
  exitCode?(summary: z.output<S>): ExitCode;
}

export type AnyCommandSpec = SingleCommandSpec<any, any> | StreamCommandSpec<any, any, any>;
export const defineCommand = <I extends z.ZodObject, O extends z.ZodObject>(
  s: Omit<SingleCommandSpec<I, O>, 'mode'>): SingleCommandSpec<I, O> => ({ ...s, mode: 'single' });
export const defineStreamCommand = <I extends z.ZodObject, E extends z.ZodType, S extends z.ZodObject>(
  s: Omit<StreamCommandSpec<I, E, S>, 'mode'>): StreamCommandSpec<I, E, S> => ({ ...s, mode: 'stream' });
```

`Context`, as passed to every handler:
```ts
export interface Context {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly signal: AbortSignal;          // aborts on deadline OR shutdown; reason is a GhxError (TIMEOUT|INTERRUPTED)
  readonly deadline: number | undefined; // clock.monotonic() at which signal fires
  readonly gh: Gh;                       // mode 'read' for read commands (mutation-guarded), 'write' otherwise
  readonly git: Git;
  readonly artifacts: ArtifactStore;
  readonly dryRun: boolean;              // write commands only
  repo(): Promise<ResolvedRepo>;         // memoized; honors spec.needs.repo
  config(): Promise<LoadedConfig>;       // memoized; honors spec.needs.config; for the TARGET repo
  warn(w: Warning): void;                // see 3.5
  preview(value: unknown): void;         // attached to the dry-run result
  log: Logger;                           // stderr NDJSON, only with --verbose
}
```

### 3.2 Global flags (reserved, never derived from input)

`--repo/-R <owner/name|host/owner/name>`, `--input <file|->`, `--schema`, `--help/-h`, `--timeout <duration>`, `--dry-run` (write commands only; usage error on reads), `--pretty`, `--max-bytes <n>`, `--verbose`.

### 3.3 How input arrives

Precedence and merge, in `src/cli/args.ts`:

1. **File or stdin JSON.** `--input path.json`, or `--input -` to read stdin. Stdin is **read only when `--input -` is given**, and the read is bounded by the deadline and a 1 MiB size cap. No implicit stdin read happens (see Pushback). Parse errors report line and column (`USAGE_INPUT_JSON`).
2. **Positionals** map in order to `spec.positionals`.
3. **Flags.** Derived from `z.toJSONSchema(spec.input, { io: 'input' })`. These top-level properties become flags: `string`, `number`/`integer`, `boolean` (with `--no-x`), string `enum`, and arrays of those (`multiple: true`, repeated flag). Names are the kebab-case of the field. Description, enum and default come from the JSON Schema (`.describe()`/`.meta()` on the zod field). Numbers are coerced from the JSON Schema type *before* zod parsing, so schemas stay strict for JSON input. Fields that aren't flaggable (objects, unions, arrays of objects) are JSON-only and listed as such in help.
4. **Merge.** Sources are shallow-merged into one object. If the same field arrives from two sources, the result is `USAGE_INPUT_CONFLICT` and no source wins silently. Then `spec.input.safeParse(merged)`.
5. **Errors.** Unknown flags (from `parseArgs` strict mode) become `USAGE_UNKNOWN_FLAG` with `details.suggestions` (§9.9). Zod failures become `VALIDATION` with `details.issues: [{path: 'testing[0].result', message, code, expected?, received?, suggestion?}]`. Each `unrecognized_keys` issue gets a "did you mean" against the schema's keys.

The recommended agent path for structured writes is to write JSON with the Write tool and then run `ghx <cmd> --input file.json`. That keeps the Bash call plain, with no heredoc and no `$(…)` (§3.2, §4.1, §9.7).

### 3.4 `--schema` and `ghx schema`

- `ghx <cmd> --schema` prints `{command, kind, mode, input, output}` for single commands, or `{…, input, event, summary}` for stream commands. Each schema is draft-2020-12 JSON Schema. Input uses `io:'input'`, so defaulted fields are optional. Output uses `io:'output'`. The global envelopes (`error`, `spilled`, `dryRun`, `streamLine`) are referenced by `$ref` to `ghx schema envelopes`.
- `ghx schema` (no target) lists `{commands:[{name, kind, mode, summary}], targets:['envelopes','config', …]}`. `ghx schema <cmd>` is the same as `ghx <cmd> --schema`. `ghx schema config` prints the config schema. `ghx schema --all` writes everything to an artifact file and returns its path, because the full set would exceed the output bound (§9.10).
- `z.toJSONSchema` throws on unrepresentable types such as `.transform()`. Every schema is enforced by `test/registry.test.ts`, not by documentation. Handlers do transforms. Schemas may use `.refine` (dropped from JSON Schema, which is fine) but not `.transform` at the input/output boundary.

### 3.5 The central runner (single mode), `src/core/runner.ts`

```ts
export async function runCommand(spec: AnyCommandSpec, argv: ParsedArgv, deps: RunDeps): Promise<ExitCode>
```

The steps run in a fixed order:
1. Build the deadline from `--timeout` or `spec.timeout.defaultMs`, clamped to `maxMs` (over the max is a usage error). Compose it with the shutdown signal from `signals.ts` into `ctx.signal`.
2. Parse input (§3.3).
3. Build the `Context`. `gh` is created in `read` mode for `kind:'read'`, so any mutating gh call throws `INTERNAL_READ_MUTATION`. That makes "reads never mutate" mechanical rather than a convention. In `write` mode with `--dry-run`, the **first mutating gh call throws an internal `DryRunHalt`**. The runner catches it and emits `{dryRun: true, wouldRun: [{argv, stdin?}], preview}`. Commands naturally do all reads and validation before their first mutation, so this shows exactly what would happen. Local fs writes (for example `ghx init`) check `ctx.dryRun` themselves.
4. `await spec.run(input, ctx)`.
5. **Validate output** with `spec.output` (extended with `warnings`, below). A failure here is a bug: `INTERNAL_OUTPUT_CONTRACT`, exit 1, with zod issues in `details`. A command cannot emit off-schema JSON.
6. **Serialize.** Compact single-line JSON by default. `--pretty` gives 2-space indent, which is also the default when stdout is a TTY.
7. **Bound.** If the serialized size exceeds `maxBytes`, write the full JSON to `artifacts.write({kind:'output', …})` and print instead `{"spilled": true, "path": "...", "bytes": N, "command": "pr status"}` with exit 0. `maxBytes` comes from `--max-bytes`, then `GHX_MAX_BYTES`, else **16384**: under Claude Code's ~30k Bash output cap and §6's 5k-char pain line, with room to spare. This is the safety net. Commands are expected to stay small by design and use `boundText()` / `artifacts` for logs and diffs (§9.10).
8. Exit code: `spec.exitCode?.(output) ?? ExitCode.OK`.
9. **Errors.** A thrown `GhxError` becomes `{"error":{"code","message","hint","details"}}` on stdout, with `hint` and `details` always present (`null` when empty) and its mapped exit code. An unknown throw becomes `INTERNAL`, with the stack written to an artifact and its path in `details.stackPath`. An abort with reason TIMEOUT or INTERRUPTED becomes that error.
10. **No pager, no prompts.** gh is spawned with its pager and prompts disabled (§4.2), and stdin is never inherited. ghx itself never reads a TTY.

**Warnings:** `defineCommand` extends every output object with `warnings: z.array(Warning).optional()`, where `Warning = {code, message, details?}`. `ctx.warn()` collects them, and the runner attaches them if there are any. In stream mode they are `{type:"warning"}` lines. stderr is never part of the contract: it carries only `--verbose` diagnostics.

**Writing safely**, in `src/core/output.ts`. Node's `process.stdout` is **asynchronous for pipes on macOS** (synchronous only on Linux). Agents always read ghx through a pipe (§3.3, §6), and a `process.exit()` after a write can truncate the final line. That would be a quiet reproduction of the §3.3 "hidden failure" class. So:
```ts
export interface Sink { writeLine(s: string): Promise<void>; } // resolves on write callback / 'drain'
```
`main.ts` sets `process.exitCode` and lets the loop drain. `process.exit` is only used on the forced-shutdown path (§3.6), and only after awaiting the terminal line. EPIPE on stdout means the reader went away: abort quietly. `architecture.test.ts` bans `process.exit(` outside `src/core/signals.ts`, and Biome bans `console.*`. This needs an e2e test on the macOS CI runner that spawns ghx, emits a large output, and asserts the last byte arrives.

### 3.6 Streaming commands (for `ci wait` and any future watchers)

02-api owns `ci wait` semantics (adaptive polling, transitions, outcomes). The skeleton provides the following.

**Handler shape.** An async generator: `yield` an event for each transition, and `return` the summary. It composes with `for await`, is trivially testable (drive it with a FakeClock and collect yields), and needs no emitter lifecycle.

**Line contract (NDJSON on stdout).** Every line is one JSON object with `type`, `seq` (from 0, monotonic) and `at` (ISO time from `clock.now()`), plus the payload:
```
{"type":"<event>","seq":0,"at":"…",...payload}       // validated against spec.event
{"type":"warning","seq":3,"at":"…","code":"…","message":"…"}
{"type":"heartbeat","seq":4,"at":"…","elapsedMs":60000}  // if heartbeatMs and silence
{"type":"summary","seq":9,"at":"…",...summary}        // terminal on success, validated against spec.summary
{"type":"error","seq":9,"at":"…","error":{code,message,hint,details}}  // terminal on failure
```
- **There is always exactly one terminal line, `summary` or `error`, and it is the last line.** A consumer such as Claude Code's Monitor or a background-run reader can rely on that.
- An event that fails its schema is `INTERNAL_OUTPUT_CONTRACT` and terminates with an `error` line.
- Each line is bounded at `maxEventBytes` (4096). An oversized payload is spilled to an artifact and the line carries `{spilled: path}` in place of the payload. There is no total-stream bound, because events are transitions, not dumps.
- The exit code is `spec.exitCode(summary)` for a summary, or the error's code for an error. 02-api defines outcome codes such as green, red, timeout and superseded.
- `--schema` describes `event`, `summary` and the shared `streamLine` envelope.

**Deadline and timers.** `--timeout` is parsed by `duration.ts` and clamped to `spec.timeout.maxMs`. A watcher can declare `maxMs: 4h` so it can run long in the background, while its `defaultMs` (for example 10 min) suits a blocking call. The deadline is a `clock.sleep(deadline)` race that aborts `ctx.signal` with `GhxError('TIMEOUT')`. No `setTimeout` exists outside `clock.ts` (§0, §5.2: macOS has no `timeout` binary; all timing is in-process).

**Graceful shutdown**, in `src/core/signals.ts`:
- The first SIGINT or SIGTERM (also SIGHUP, and EPIPE on stdout) aborts the shutdown controller with `GhxError('INTERRUPTED', {details:{signal}})`. That cancels `clock.sleep` and kills in-flight gh children (§4.1).
- A generator that catches the abort and `return`s a summary, for example `{outcome:'interrupted', lastState}`, gets that summary emitted as terminal. This is the preferred path, and helper `isAbort(e)` makes it a 3-line pattern.
- If the generator lets the abort propagate, the runner emits a terminal `error` line with `INTERRUPTED` or `TIMEOUT`.
- **Grace window:** 3 s, measured by Clock. If the generator hasn't settled by then, the runner calls `it.return()`, emits `error INTERRUPTED`, awaits the write and exits. A **second signal** skips the grace window.
- Signal exit codes are 130 for SIGINT and 143 for SIGTERM. The deadline gives `ExitCode.TIMEOUT`.
- Single-mode commands get the same handling: a terminal `{"error":…}` object instead of a line.

**Clock**, in `src/core/clock.ts`:
```ts
export interface Clock {
  now(): number;                                    // epoch ms (timestamps)
  monotonic(): number;                              // ms, for deadlines/intervals
  sleep(ms: number, signal?: AbortSignal): Promise<void>; // rejects with signal.reason on abort
}
export const realClock: Clock; // Date.now, performance.now, timers/promises.setTimeout({signal})
```
`test/helpers/fake-clock.ts` has the test version:
```ts
export class FakeClock implements Clock {
  constructor(startEpochMs?: number);
  advance(ms: number): Promise<void>;   // fires due timers in order; flushes microtasks + one setImmediate between each
  runUntil(pred: () => boolean, opts?: { stepMs?: number; maxMs?: number }): Promise<void>;
  pendingTimers(): number;
}
```
All time-dependent code takes `Clock` from Context or deps: poll loops, retries and backoff, gh per-attempt timeouts, deadline, grace window and heartbeat. Tests run a "10-minute" wait in milliseconds of real time. `architecture.test.ts` greps `src/` for `setTimeout(`, `setInterval(`, `Date.now(`, `performance.now(` and `timers/promises` outside `clock.ts`.

**Poll primitive**, in `src/core/poll.ts`, is used by watchers and by bounded retries such as `mergeable: UNKNOWN` (§5.2, §9.3):
```ts
export interface PollOptions<T> {
  probe(signal: AbortSignal): Promise<T>;
  done(value: T): boolean;
  interval: { initialMs: number; maxMs: number; factor: number; jitter: number };
  budget?: () => RateBudget | undefined;            // stretches interval when budget is low (4.4)
  onValue?(value: T, prev: T | undefined): void;    // transition hook
  clock: Clock; signal: AbortSignal; maxAttempts?: number;
}
export function poll<T>(o: PollOptions<T>): AsyncGenerator<T, T, void>;
```

### 3.7 Router, help and unknown commands

- `router.ts` matches the longest prefix of positionals against registered `name`s. Ambiguity is impossible by construction, because `registry.test.ts` checks it.
- Unknown commands go to `onUnknown(argv): never | Promise<ExitCode>`, which defaults to refusing with `USAGE_UNKNOWN_COMMAND` plus suggestions. **02-api owns the passthrough policy. The skeleton exposes the `onUnknown` hook and the `replaces` metadata to build a "use X instead" hint.**
- `ghx --help` (and `ghx help`) prints JSON. See §7 for its shape.

### 3.8 Generic invariants: `test/registry.test.ts`

This test iterates `commands/index.ts` and asserts the following for every spec:
- `name` is unique, and no spec's name is a prefix of another's positional slot.
- `summary` is non-empty and ≤ 100 chars.
- `z.toJSONSchema` succeeds for input (`io:'input'`), output, event and summary, so no transforms are present.
- No derived flag collides with a reserved global flag (§3.2), and positionals name real fields.
- A `read` command, run through the harness with a FakeProcessRunner that records calls, never issues a call classified as mutating. Each command supplies a minimal fixture via an `examples[0]`-driven smoke test.
- A `write` command accepts `--dry-run`, and with a fixture its dry run halts before any mutating call.
- Stream specs have an `event` union whose `type` literals avoid the reserved names.

This is how 02-api's commands stay consistent without anyone reviewing each one by hand.

---

## 4. The gh exec layer (`src/gh/`)

### 4.1 Process seam (`src/proc/runner.ts`)

There is one seam for both `gh` and `git`. Tests replace it.
```ts
export interface ProcRequest {
  cmd: string; args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string; stdin?: string;
  signal: AbortSignal; timeoutMs?: number;
  stdoutFile?: string;          // stream stdout to a file (logs) instead of buffering
  maxBuffer?: number;           // default 32 MiB; overflow → error PROC_OUTPUT_TOO_LARGE
}
export interface ProcResult {
  exitCode: number | null; signal: NodeJS.Signals | null;
  stdout: string; stderr: string;
  timedOut: boolean; aborted: boolean; durationMs: number;
  spawnError?: NodeJS.ErrnoException;  // ENOENT → gh not installed
}
export type ProcessRunner = (req: ProcRequest) => Promise<ProcResult>;
export function createSpawnRunner(deps: { clock: Clock }): ProcessRunner;
```
- The real implementation uses `spawn` with `stdio: ['pipe' | 'ignore', 'pipe', 'pipe']`, so stdin is never inherited and nothing can wait on a TTY.
- On timeout or abort it sends SIGTERM, then SIGKILL after 2 s (Clock).

### 4.2 Child environment (`src/gh/env.ts`)

`GH_PAGER=""`, `PAGER=cat`, `NO_COLOR=1`, `CLICOLOR=0`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`. It also *deletes* `GH_FORCE_TTY`, `CLICOLOR_FORCE` and `GH_DEBUG` (`GH_DEBUG` is kept only with `--verbose`). Auth and host variables pass through untouched (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, `GH_ENTERPRISE_TOKEN`, `GH_CONFIG_DIR`), because gh owns auth (brief, Goal).

### 4.3 The `Gh` interface

```ts
export type GhMode = 'read' | 'write';

export interface GhCall {
  args: readonly string[];            // without leading 'gh'
  repo?: RepoRef;                     // ALWAYS passed explicitly as -R host/owner/name (never cwd inference)
  stdin?: string;
  mutates?: boolean;                  // must equal guard.isMutating(args); mismatch → INTERNAL (forces intent)
  allowExit?: readonly number[];      // non-zero exits that are data (e.g. `pr checks` 8 = pending, §3.3)
  timeoutMs?: number;                 // per attempt; default min(30s, time left before ctx deadline)
  retry?: RetryPolicy | 'none';       // default: transient retry for non-mutating; 'none' for mutating
  stdoutFile?: string;
  cache?: boolean;                    // memoize identical read calls within one invocation
}
export interface GhResult { exitCode: number; stdout: string; stderr: string; attempts: number; durationMs: number }

export interface ApiRequest {
  path: string;                       // 'repos/{owner}/{repo}/actions/jobs/123/logs'; placeholders from repo
  repo?: RepoRef;                     // supplies {owner}/{repo} and --hostname
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';  // default GET; always passed as -X
  fields?: Record<string, string | number | boolean>;      // -F
  body?: unknown;                     // --input - (JSON)
  headers?: Record<string, string>;   // e.g. If-None-Match for conditional polling
  paginate?: { maxPages: number; perPage?: number };      // manual Link-header pagination
  toFile?: string;                    // raw body to file (logs)
}
export interface ApiResponse<T> {
  status: number; headers: Record<string, string>;   // lower-cased
  data: T; pages: number; truncated: boolean;        // truncated: hit maxPages with a next link remaining
  etag?: string; notModified: boolean;
}

export interface Gh {
  readonly mode: GhMode;
  exec(call: GhCall): Promise<GhResult>;
  json<S extends z.ZodType>(call: GhCall, schema: S): Promise<z.output<S>>; // parse + validate gh's JSON
  api<S extends z.ZodType>(req: ApiRequest, schema: S): Promise<ApiResponse<z.output<S>>>;
  apiText(req: ApiRequest): Promise<ApiResponse<string>>;                  // logs, diffs
  graphql<S extends z.ZodType>(query: string, vars: Record<string, unknown>, schema: S,
                               opts?: { repo?: RepoRef; mutates?: boolean }): Promise<z.output<S>>;
  rateBudget(resource?: RateResource): RateBudget | undefined;            // last observed
  refreshRateBudget(): Promise<Partial<Record<RateResource, RateBudget>>>; // GET rate_limit (doesn't count)
  version(): Promise<GhVersion>;
}

export function createGh(deps: {
  proc: ProcessRunner; clock: Clock; signal: AbortSignal; mode: GhMode;
  dryRun?: boolean; env?: Record<string, string | undefined>;
  maxConcurrency?: number;            // default 4; composite reads (pr status) fan out (§8b)
  log?: Logger; ghPath?: string;      // GHX_GH_PATH override for tests
}): Gh;
```

- **Validation of gh's own output.** `json()` and `api()` validate with zod. Drift becomes `GH_OUTPUT_UNEXPECTED` with the zod issues, and is never silently passed on (§9.9).
- **Read guard** (`guard.ts`). In read mode only an allowlist passes: `pr view|list|checks|diff`, `run view|list|download`, `api` with GET and no `-f/-F/--input` (gh switches to POST when fields are present), `graphql` whose operation isn't `mutation`, `auth status`, `repo view`, `--version`. Anything else throws `INTERNAL_READ_MUTATION`. Deny is the default.
- **Error classification** (`classify.ts`) is a table of `{code, match: RegExp | ((r) => boolean), transient: boolean, retryAfter?: (r) => number}`, tested against verbatim §3.1 strings in `test/fixtures/gh-stderr/`:

| Code | Signal | Transient |
|---|---|---|
| `GH_NOT_INSTALLED` | spawn ENOENT | no |
| `GH_AUTH` | `gh auth login`, HTTP 401 | no |
| `GH_NOT_FOUND` | `Could not resolve to a`, HTTP 404 | no |
| `GH_RATE_LIMITED` | HTTP 403/429 with `rate limit` or `secondary rate limit`; carries `retryAfterMs` | yes (honor reset/Retry-After) |
| `GH_TRANSIENT` | `Something went wrong while executing your query` (§3.1, #3214), HTTP 500/502/503/504, `connection reset`, `i/o timeout`, `EOF` | yes |
| `GH_TOO_LARGE` | HTTP 406 `exceeded the maximum number of files` (§3.1, §9.10) | no |
| `GH_IN_PROGRESS` | `is still in progress; logs will be available` (§0) | no (callers use the jobs API) |
| `GH_NO_CHECKS` | `no checks reported` (§3.1, §5.2) | no (callers treat it as pending) |
| `GH_ALREADY` | `already merged`, `already running`, `cannot be rerun` (§3.1) | no |
| `GH_NOT_A_REPO` | `not a git repository`, `failed to determine base repo` (§3.1) | no |
| `GH_TIMEOUT` | per-attempt timeout | yes (once) |
| `GH_FAILED` | anything else; `details: {argv, exitCode, stderrTail}` | no |

- **Retries** (`retry.ts`). The default is `{attempts: 3, baseMs: 500, maxMs: 8000, jitter: 0.25}` on transient codes, honoring `retryAfterMs`, and never past the deadline. Mutating calls default to `'none'`. A write may opt in with `retry: {…, idempotent: true}`. One example is a merge pinned with `--match-head-commit`, which is safe to repeat and matches §3.1's #3214 recovery. After a failed write, verifying state is the command's job.
- **Repo is always explicit on the wire.** Every call carries `-R` or a filled `repos/{owner}/{repo}` path. gh's own cwd inference is never relied on, which removes the sektar #3258 class at the transport (§3.1, §4.1).
- **Dry run.** With `dryRun` and a mutating call, the layer throws `DryRunHalt({argv, stdin})` (§3.5).

### 4.4 Rate-limit budget (for pollers)

- `api()` and `graphql()` always pass `--include`, then parse the status line and headers. `ratelimit.ts` keeps the latest values per resource: `x-ratelimit-resource`, `-limit`, `-remaining`, `-used`, `-reset`, and `retry-after`.
  ```ts
  export type RateResource = 'core' | 'graphql' | 'search' | (string & {});
  export interface RateBudget { resource: RateResource; limit: number; remaining: number; used: number; resetAt: number; observedAt: number }
  export function suggestInterval(baseMs: number, b: RateBudget | undefined, clock: Clock): number;
  // stretches so that remaining requests last until resetAt with 20% headroom; floor baseMs; honors Retry-After
  ```
- GraphQL helpers may also select `rateLimit { remaining resetAt cost }` and feed the tracker.
- `refreshRateBudget()` calls `GET /rate_limit`, which doesn't count against the limit.
- **Manual pagination** follows `Link: rel="next"` up to `maxPages`, rather than `--paginate`. `--include --paginate` interleaves header blocks per page. Manual pagination gives per-page headers, a hard bound (§9.10), and `truncated: true` when the bound is hit.
- **Conditional polling.** `headers: {'If-None-Match': etag}` should yield `status 304, notModified: true`, which GitHub doesn't count against REST limits. *Verify at commit 6* how `gh api --include` reports 304 (exit code and body). If gh treats it as an error, classify 304 as success in `api.ts`.
- **Note for 02-api:** porcelain commands (`pr checks`, `pr view`, `run list`) expose **no** rate headers. Pollers should be built on `gh.api`/`gh.graphql` so the budget is observable. `poll()` takes `budget: () => ctx.gh.rateBudget('core')`.

### 4.5 Repo resolution (`src/gh/repo.ts`, `src/gh/refs.ts`, `src/git/index.ts`)

```ts
export interface RepoRef { host: string; owner: string; name: string }   // host default 'github.com'
export type RepoSource = 'flag' | 'url' | 'env' | 'cwd';
export interface ResolvedRepo { repo: RepoRef; source: RepoSource; cwdRepo?: RepoRef; cwdToplevel?: string }

export function parseRepo(s: string): RepoRef;                      // owner/name, host/owner/name, https/ssh remote URLs
export function parseTargetRef(s: string): { kind: 'pr' | 'run' | 'job'; number: number; repo?: RepoRef; runId?: number };
export function resolveRepo(o: { flag?: string; ref?: string; env: Env; git: Git; need: RepoNeed }): Promise<ResolvedRepo>;
```
- **Precedence:** `--repo`, then a repo embedded in the ref (`o/r#123` or a URL), then `GH_REPO`, then the cwd remote.
- **Cwd remote resolution is local, with no network,** and mirrors gh: a remote with `remote.<name>.gh-resolved=base` wins. Otherwise the order is `upstream`, `github`, `origin`, then others. Non-GitHub hosts are ignored unless they match `GH_HOST`.
- **Mismatch rules:**
  1. `--repo` and the ref's repo disagree: `USAGE_REPO_MISMATCH`, listing both.
  2. `need: 'explicit'` and only the cwd is available: `USAGE_REPO_REQUIRED`, with hint `pass --repo owner/name (cwd resolves to X)`. 02-api picks which commands need it; §9.4 suggests writes do.
  3. Several GitHub remotes point to different repos and none is gh-resolved: `REPO_AMBIGUOUS`, listing them, with hint `--repo` or `gh repo set-default`.
  4. The repo was inferred from the cwd and the target isn't found: the `GH_NOT_FOUND` error is enriched with `details: {repo, source: 'cwd', cwdToplevel}` and hint `PR #N not found in o/r (inferred from cwd). Pass --repo or the PR URL.` This is the sektar #3258 case (§3.1, §4.1).
  5. An explicit repo that differs from the cwd repo is allowed for reads. For writes whose input reads local git state (for example a head branch from the working tree), the command calls `ctx.warn({code:'CWD_REPO_DIFFERS'})` or refuses. That is 02-api's call.

---

## 5. Per-repo config

**Location: `.github/ghx.json`** at the git toplevel. This is a minor deviation from "repo root"; see Pushback. It's strict JSON, so a typo can't be ignored, and it allows an optional `"$schema"` key. It's discovered with `git rev-parse --show-toplevel`. Nothing walks up beyond the toplevel, and there is no fallback filename.

**The config is for the target repo, not the cwd repo** (`src/config/load.ts`):
```ts
export interface LoadedConfig {
  config: GhxConfig;
  source: { kind: 'local'; path: string }
        | { kind: 'remote'; repo: RepoRef; ref: string; path: '.github/ghx.json' }
        | { kind: 'default' };      // only when need is 'optional' and the file is absent
}
export function loadConfig(o: { target: ResolvedRepo; git: Git; gh: Gh; need: ConfigNeed }): Promise<LoadedConfig>;
```
1. If the cwd toplevel's resolved repo equals the target, read the local working-copy file. Uncommitted edits count, which is how you iterate on policy.
2. Otherwise, when `--repo` or a URL points elsewhere (§4.1 cross-repo, sektar), fetch `GET repos/{o}/{r}/contents/.github/ghx.json` from the default branch (a read call; base64 decode).
3. Local wins whenever it applies, and the two are never merged. `source` is reported in `ghx doctor` and in `details` of config errors.
4. `need: 'required'` and absent: `CONFIG_MISSING`. `need: 'optional'` and absent: defaults. **Invalid is always an error, whatever the need.** A broken policy file is never skipped silently (brief 3 and 6).

**Errors**, each with `details.source`:
- `CONFIG_MISSING`: hint `run: ghx init`.
- `CONFIG_INVALID_JSON`: `details: {line, column}`.
- `CONFIG_INVALID`: `details.issues: [{path:'merge.method', message, received?, suggestion?}]`. Unknown keys get "did you mean" (`componets` → `components`).
- `CONFIG_UNSUPPORTED_VERSION`.

**Schema skeleton** (`src/config/schema.ts`). 02-api adds fields inside the sections it owns: `merge`, `pr` and `checks` semantics.
```ts
const ComponentName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).describe('Conventional-commit scope token');
const Glob = z.string().min(1).refine(isValidGlob, 'invalid glob');
const MergeMethod = z.enum(['merge', 'squash', 'rebase']);

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  components: z.record(ComponentName, z.strictObject({
    description: z.string().max(200).optional(),
    paths: z.array(Glob).min(1).optional(),            // maps changed files → components
  })).refine((r) => Object.keys(r).length > 0, 'declare at least one component'),
  checks: z.strictObject({
    ignore: z.array(z.union([
      z.string(),                                        // exact check name or glob, e.g. "notify-discord" (§6)
      z.strictObject({ name: z.string(), workflow: z.string().optional(), reason: z.string() }),
    ])).prefault([]),
  }).prefault({}),
  merge: z.strictObject({
    method: MergeMethod.prefault('merge'),               // §4.3: default merge, squash only by override
    allowedMethods: z.array(MergeMethod).min(1).prefault(['merge']),
  }).prefault({}),
  pr: z.strictObject({
    title: z.strictObject({
      maxLength: z.number().int().min(20).max(256).prefault(72),   // §4.1: 40/73 over 72
      conventional: z.boolean().prefault(true),
      scope: z.enum(['required', 'optional', 'none']).prefault('optional'),
    }).prefault({}),
    render: z.strictObject({
      style: z.enum(['trailer', 'details', 'hidden']).prefault('trailer'),  // brief 5
      footer: z.string().nullable().prefault('🤖 Generated with [Claude Code](https://claude.com/claude-code)'),
    }).prefault({}),
  }).prefault({}),
}).superRefine((c, ctx) => { /* merge.method ∈ allowedMethods; ignore globs compile; component globs compile */ });
export type GhxConfig = z.output<typeof ConfigSchema>;
```
In zod 4, `.default(v)` returns `v` *without parsing*, so nested defaults wouldn't apply. `.prefault(v)` parses `v`, so nested defaults fill in. *Verify at commit 11 against the zod 4 changelog*, and add a test that `{version:1, components:{x:{}}}` parses to fully populated sections.

**`ghx init`** (`src/commands/init.ts`, kind `write`, `needs.repo:'none'`):
- It writes `.github/ghx.json` at the git toplevel.
- Components come from `--component <name>` (repeatable) or are inferred: `package.json#workspaces` and `pnpm-workspace.yaml` `packages:` (line-parsed, no YAML dep), expanded with `fs.glob`, giving each package dir `{paths:['<dir>/**']}`. If no workspace is found, it falls back to top-level non-dot directories.
- The starter object is run through `ConfigSchema.parse` before writing, so the starter is valid by construction.
- It refuses to overwrite without `--force`. `--dry-run` returns the config without writing.
- Output: `{path, written, config, inferredFrom: 'flags'|'workspaces'|'directories'}`.
- Inferring noise checks from recent check history is deferred, because it needs network and a heuristic.

**User-level config: no, not in v1.**
- Policy (merge method, components, noise checks) must have one source that agents can't quietly override from their home directory. That is the point of enforcing §4.3/§7 policy in a reviewed file.
- The few genuinely per-machine knobs are env vars: `GHX_ARTIFACT_DIR`, `GHX_MAX_BYTES`, `GHX_GH_PATH`, `GHX_HOOK_MODE`.
- Revisit if a repo-independent preference shows up that isn't policy.

---

## 6. Hidden metadata codec (`src/meta/codec.ts`)

02-api owns the payload schemas (PR, review, comment, versioning policy). The skeleton owns the wire format and the codec.

```ts
export interface MetaSchemas { [version: number]: z.ZodType }        // supplied by 02-api, e.g. {1: GhxMetaV1}
export type Decoded<T> =
  | { status: 'absent' }
  | { status: 'ok'; version: number; data: T; raw: string; range: [number, number] }
  | { status: 'invalid'; reason: 'json' | 'schema' | 'unsupported-version'; version?: number; raw: string; issues?: unknown };

export function encode(data: unknown, version?: number): string;      // → '<!-- ghx:v1 {...} -->'
export function decode<T>(body: string, schemas: MetaSchemas): Decoded<T>;   // last block wins; see below
export function decodeAll(body: string, schemas: MetaSchemas): Decoded<unknown>[];
export function upsert(body: string, data: unknown, version?: number): string; // replace in place, else append
export function strip(body: string): string;                          // visible text without ghx blocks
```
- **Escaping argument.** JSON syntax outside string literals never contains `<` or `>`. So after `stableStringify`, every `<` becomes `<` and every `>` becomes `>`. Any occurrence is inside a string literal, where the escape decodes back to the same character. This makes `-->`, `--!>` and `<!--` impossible inside the block, which covers the HTML comment rules, and `JSON.parse` round-trips exactly. `&` is irrelevant inside comments.
- **Pattern:** `/<!--\s*ghx:v(\d+)\s+(\{[\s\S]*?\})\s*-->/g`. The lazy match is safe because our JSON has no raw `>`. Whitespace tolerance and CRLF are both handled.
- **Placement and format:** the block goes on its own line at the end of the body, after the footer, preceded by a blank line. It's a single line. Keys are sorted (`stableStringify`) so edits diff cleanly.
- **Tolerance:**
  - Absence is a normal result: PRs without a block are `structured:false` (brief 7).
  - Several blocks: the last one wins, and `decodeAll` exposes the rest, so a caller can warn.
  - A block that is malformed or of an unknown version is `invalid` and never throws. Other HTML comment markers such as `<!-- ci-duration-watch -->` (§8c) are ignored.
- **Size guard:** if `encode` plus the body would exceed GitHub's 65,536-char body limit, the result is `META_TOO_LARGE`.
- **Tests:** round-trip property cases (strings containing `-->`, `--!>`, `<!--`, `<script>`, newlines, emoji, U+2028), real bodies from `test/fixtures/bodies/`, and upsert idempotence.

`src/render/markdown.ts` holds only pure, generic helpers: compact trailer joining, footer append, and escaping. The body *templates* belong to 02-api.

---

## 7. Agent-facing docs and discovery

**`ghx --help` prints JSON**, keeping one contract and staying under 4 KB:
```json
{"name":"ghx","version":"0.1.0",
 "summary":"GitHub for agents: validated writes, one-call reads. Wraps gh.",
 "usage":"ghx <group> <command> [positionals] [--flags] [--input file.json|-]",
 "rules":["One plain call per question: no pipes, --jq, head, sleep or timeout.",
          "stdout is JSON (or NDJSON for stream commands); errors are {error:{code,message,hint,details}} with non-zero exit.",
          "Large artifacts are written to files; the result carries their paths."],
 "globalFlags":[{"flag":"--repo","alias":"-R","type":"string","description":"owner/name; overrides cwd"}, "..."],
 "commands":[{"name":"doctor","kind":"read","mode":"single","summary":"…","replaces":[]}, "..."],
 "next":"ghx <command> --help for flags and examples; ghx <command> --schema for JSON Schema; ghx doctor to check setup"}
```

**`ghx <cmd> --help`** returns `{name, summary, description, kind, mode, positionals, flags:[{flag, type, required, enum?, default?, multiple?, description}], jsonOnlyFields:[…], input:"…--input file.json…", examples, replaces, timeout:{defaultMs,maxMs}}`.

**`ghx schema …`** is described in §3.4.

**`docs/agents/claude-md-snippet.md`**. The command names are placeholders until 02-api lands.
```md
## GitHub: use `ghx`, not `gh`
- Use `ghx` for PRs and CI. Run it as one plain command: no pipes, `--jq`, `head`, `sleep` or `timeout`; it bounds its own output and time.
- Discover with `ghx --help`, `ghx <cmd> --help`, `ghx <cmd> --schema`. Check setup with `ghx doctor`.
- Structured writes: write the input JSON with the Write tool, then `ghx <cmd> --input path.json`. Run with `--dry-run` first to see exactly what would be sent.
- Errors: `{"error":{"code","message","hint","details"}}` with non-zero exit. Follow `hint`; don't retry blindly.
- Big outputs (logs, diffs) come back as file paths. Read the file; don't re-fetch.
- Stream commands print one JSON event per line; the last line is always `summary` or `error`. Run long waits in the background.
- Use raw `gh` only for things ghx doesn't cover, and never for merges or PR creation.
```

**`docs/agents/skill/ghx/SKILL.md`** is a Claude Code skill. Its frontmatter is `name: ghx` and `description: Use for any GitHub PR or CI task (status, why CI failed, waiting, creating, commenting, merging)`. The body is the snippet plus a short command index generated from the registry. A `pnpm docs:gen` script regenerates it, and a test fails if it's stale.

**Discouraging raw `gh`** (`docs/agents/hooks.md`):
1. **Hard, for writes, no code:** add `permissions.deny` rules to Claude Code settings: `Bash(gh pr merge:*)`, `Bash(gh pr create:*)`, `Bash(gh pr edit:*)`, `Bash(gh pr review:*)`, `Bash(gh pr comment:*)`. Writes must go through ghx policy (§4.3, §7).
2. **Advisory, for reads (optional, last commit):** `ghx hook claude-pretooluse` reads the PreToolUse event JSON from stdin (explicit by protocol) and matches `tool_input.command` against patterns built from every spec's `replaces`. It replies `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask","permissionDecisionReason":"Use `ghx …` instead: …"}}`. `GHX_HOOK_MODE=deny|ask|off` controls it. **It fails open:** any internal error exits 0 with no output, so a broken ghx never blocks the agent. Its latency budget is under 100 ms, with no gh calls. Settings: `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"ghx hook claude-pretooluse"}]}]}}`.

---

## 8. Supporting pieces

**Errors and exit codes** (`src/core/errors.ts`, `exit.ts`):
```ts
export class GhxError extends Error {
  constructor(readonly code: ErrorCode, message: string,
              readonly opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {}) { super(message); }
}
export const ERROR_CODES = { VALIDATION: { exit: ExitCode.USAGE }, /* … */ } satisfies Record<string, { exit: ExitCode }>;
export function toErrorObject(e: unknown): { error: { code: string; message: string; hint: string | null; details: Record<string, unknown> | null } };
```
**The exit-code table below is provisional. 02-api owns it; the skeleton exposes `ExitCode` and the `ERROR_CODES` registry.** These are the placeholder values the bootstrap uses:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | INTERNAL (a bug, including an output-contract violation) |
| 2 | USAGE / VALIDATION |
| 3 | CONFIG |
| 4 | ENV (gh missing or too old, not authed) |
| 5 | NOT_FOUND |
| 6 | POLICY (a write refused) |
| 7 | GH_FAILED (including exhausted retries) |
| 8 | TIMEOUT |
| 10–19 | reserved for command outcomes, such as `ci wait` red or superseded |
| 130 / 143 | SIGINT / SIGTERM |

**Artifacts** (`src/core/artifacts.ts`):
```ts
export interface ArtifactRef { path: string; bytes: number; sha256: string; kind: string }
export interface ArtifactStore {
  readonly root: string;
  write(a: { kind: string; name: string; content: string | Uint8Array }): Promise<ArtifactRef>;
  pathFor(kind: string, name: string): Promise<string>;   // mkdir -p; for gh stdoutFile streaming
}
export function boundText(text: string, o: { maxLines: number; maxBytes: number }): { excerpt: string; truncated: boolean; totalLines: number };
```
- The root is `GHX_ARTIFACT_DIR`, else `${os.tmpdir()}/ghx`. The layout is `<root>/<host>/<owner>/<repo>/<kind>/<name>`. Names are deterministic (for example `logs/job-111978835495.log`), so a repeat call reuses the file.
- Files older than 7 days are pruned lazily, on the first write in a process. Paths are absolute.
- If a harness restricts reads outside the project, the docs say to set `GHX_ARTIFACT_DIR` to an ignored project-local directory.

**`ghx doctor`** (read, single, `needs: {repo:'optional', config:'optional'}`) runs these checks:
- gh on PATH and its version.
- **Feature probes**, not a guessed floor: `gh auth status --json hosts` must succeed, and `gh pr checks --help` must list `--json`. `MIN_GH_VERSION` is set *at commit 14* from the cli/cli release notes for those two features. The local gh is 2.86.0.
- Auth on the target host: active account, state, and token scopes including `repo`.
- `git` present, and cwd repo resolution (informational).
- Config: source and validity, with issues.

Output: `{ok, gh:{path, version, minVersion, ok}, auth:{host, login, ok, scopes}, git:{ok, toplevel, repo, repoSource}, config:{status:'valid'|'missing'|'invalid'|'skipped', source, issues?}, checks:[{name, ok, message, hint}]}`. The exit code is 0 when everything is ok and `ENV`, `CONFIG` or `INTERNAL` otherwise, via `exitCode(output)`.

---

## 9. Bootstrap sequence

All commits land on `main`, with no branches and no push (user's global CLAUDE.md). Every commit leaves `pnpm check` green and includes its own tests.

1. **`chore: project tooling`**: package.json (pnpm, `private`, `type: module`, engines), tsconfig.json, biome.json, .node-version, .gitignore, and `test/sanity.test.ts` (asserts Node ≥ 24). Installs zod, typescript, @types/node and biome.
2. **`ci: typecheck, lint and test on ubuntu and macos`**: `.github/workflows/ci.yml`. macOS is required for the pipe-flush behavior and the missing `timeout` binary.
3. **`feat(core): errors, exit codes, stable JSON, sink`**: errors.ts, exit.ts, util/json.ts, output.ts (Sink with drain, `boundText`), suggest.ts. Tests cover the error envelope (`hint`/`details` null), zod-issue mapping and suggestions.
4. **`feat(core): clock, duration, signals, poll`**: clock.ts, duration.ts, signals.ts, poll.ts, and test/helpers/fake-clock.ts. Tests drive FakeClock: backoff, deadline abort reason, grace-window expiry and second signal. Also `test/architecture.test.ts` (timer and exit greps).
5. **`feat(proc): process runner with timeout and abort`**: proc/runner.ts and test/helpers/fake-proc.ts. Real-spawn tests use `process.execPath -e …` for exit codes, timeout kill, abort, stdoutFile and ENOENT.
6. **`feat(gh): exec core (env, classify, retry, read guard, version)`**: gh/index.ts `exec`/`json`, env.ts, classify.ts with §3.1 stderr fixtures, retry.ts, guard.ts, version.ts. Tests cover the env contents, every classifier row, transient retry with FakeClock, read-mode refusal, and the dry-run halt.
7. **`feat(gh): api and graphql with headers, pagination, rate budget`**: api.ts, graphql.ts, ratelimit.ts. Tests cover header parsing, Link pagination with `maxPages`/`truncated`, `suggestInterval`, 304 handling (verify gh behavior here), and graphql mutation detection.
8. **`feat(gh): repo refs and resolution`**: refs.ts, repo.ts, git/index.ts. Tests cover parsing of every ref form, remote precedence, `gh-resolved`, and each of the 5 mismatch rules, including an enriched not-found for the sektar case.
9. **`feat(cli): command spec, runner, args, router, help, schema; ghx version`**: core/command.ts, context.ts, runner.ts, artifacts.ts (spill), cli/*, src/main.ts, bin/ghx.js, commands/version.ts, commands/index.ts, test/helpers/harness.ts, and `test/registry.test.ts`. Tests:
   - harness runs of `ghx version`, `--help`, `version --schema`, unknown flag with a suggestion, `--input` conflict, and spill over `--max-bytes`;
   - **an e2e test** that spawns `bin/ghx.js version` and checks stdout JSON, exit 0 and a complete final byte.
10. **`feat(core): streaming commands`**: core/stream.ts and a test-only `_tick` stream command registered via the harness. Tests cover NDJSON envelope and seq, the always-terminal line, event schema violation leading to a terminal error, the heartbeat, SIGTERM leading to a summary (graceful) or an error (ungraceful), deadline timeout, the second-signal force, and exit code from the summary. All of it runs on FakeClock.
11. **`feat(config): schema and loader`**: config/schema.ts, load.ts and fixtures. Tests cover prefault population, strict-key suggestions, JSON line and column, local-vs-remote selection by target repo, and invalid-is-always-error. Also `ghx schema config`.
12. **`feat(meta): ghx:vN block codec`**: meta/codec.ts and body fixtures. Tests cover escaping, round-trip, absent/invalid/multiple blocks, upsert idempotence and the size guard.
13. **`feat: ghx init`**: config/starter.ts, commands/init.ts. Tests run on a temp dir with a pnpm workspace: inference, `--force`, `--dry-run`, and output that is valid by construction.
14. **`feat: ghx doctor`**: commands/doctor.ts and `test/fixtures/bin/gh` (fake gh replaying `test/fixtures/gh/doctor-*`). Tests: harness tests for ok, gh missing, gh too old or failed probe, unauthenticated, and invalid config. **An e2e test** spawns `bin/ghx.js doctor` with `PATH=test/fixtures/bin:…` and asserts the JSON shape, the exit codes, and that the fake gh saw `GH_PROMPT_DISABLED=1` and `GH_PAGER=` (the fake records its env). This is the end-to-end proof that the full framework works: router, args, context, mode-guarded gh, proc spawn, config, output contract and exit code.
15. **`docs(agents): CLAUDE.md snippet, skill, hooks guide`**: docs/agents/*, plus `.github/ghx.json` dogfood config, validated by a test running `loadConfig` on this repo.
16. *(optional)* **`feat: ghx hook claude-pretooluse`**: commands/hook.ts. Tests cover deny/ask/off, fail-open on bad stdin, and that a pattern built from `replaces` matches §2.1-style commands.

After commit 14, 02-api commands drop into `src/commands/{pr,ci}/` and are covered by `registry.test.ts` automatically.

---

## Pushback

- **Config location: `.github/ghx.json`, not `<root>/.ghx.json`.** It sits beside the other repo-level GitHub policy (`CODEOWNERS`, `dependabot.yml`) and can be CODEOWNERS-protected. The cross-repo remote fetch works the same either way. If the brief's root placement is preferred, it's a one-constant change.
- **"JSON on stdin" becomes explicit `--input -` only.** An implicit stdin read can hang when a harness leaves stdin as an open, never-closed pipe. The primary documented path is to write the JSON with the Write tool and pass `--input file.json`. Heredocs and `$(…)` bodies are exactly what tripped the worktree guard and caused title drift (§3.2: 19 refusals; §4.1: the `printf` body was refused and the title changed on retry).
- **Amendment to "JSON on stdout, bounded":** stdout is *either* one bounded JSON document *or* (for `mode:'stream'` commands) NDJSON whose last line is always a terminal `summary` or `error`. The bound applies per event line. Over-limit single outputs spill to a file and return `{spilled, path, bytes}` with exit 0. The brief should state these three shapes.
- **The error object always has all four keys.** `hint` and `details` are `null` when empty, never omitted, so agents can read them without existence checks.
- **No user-level config** (the brief is silent). Policy lives only in the repo file, and per-machine knobs are env vars (§5).
- **Read commands can't mutate, enforced mechanically.** They receive a gh in read mode with a deny-by-default allowlist. This tightens "reads never mutate" from a convention to a guarantee. It's not a deviation, but 02-api should know that read commands can't call write endpoints even incidentally.
- **Note for 02-api (not a framework gap):** porcelain gh commands expose no rate-limit headers. Pollers (`ci wait`) should use `gh.api`/`gh.graphql` so `rateBudget()` is meaningful.

### Critical Files for Implementation
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/src/core/command.ts
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/src/core/runner.ts (with src/core/stream.ts)
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/src/gh/index.ts (with src/gh/classify.ts, src/gh/repo.ts)
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/src/config/load.ts
- /Users/benjaminjordan/projects/thegoldenmule/gh-for-agents/test/registry.test.ts