// The test-only stream command (01 §1 `_tick`): ticks on the Clock, then returns a summary. Flags
// drive every runner path: failures, bad events, warnings, graceful vs ungraceful shutdown, big lines.
import { z } from 'zod';
import { defineStreamCommand, type TimeoutSpec } from '../../src/core/command.ts';
import { GhxError } from '../../src/core/errors.ts';
import { ExitCode } from '../../src/core/exit.ts';
import { isAbort } from '../../src/core/signals.ts';

export const TickInput = z.strictObject({
  count: z.number().int().min(0).default(3),
  intervalMs: z.number().int().min(0).default(1_000),
  stream: z.boolean().default(false).describe('NDJSON on stdout (default: one final document)'),
  failAt: z.number().int().optional(),
  badEventAt: z.number().int().optional(),
  reservedAt: z.number().int().optional(),
  warnAt: z.number().int().optional(),
  graceful: z.boolean().default(true),
  ignoreAbort: z.boolean().default(false),
  payloadBytes: z.number().int().min(0).default(0),
  red: z.boolean().default(false),
  summaryBytes: z.number().int().min(0).default(0),
});

export const TickEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tick'), n: z.number().int(), pad: z.string().optional() }),
  z.object({ type: z.literal('note'), text: z.string() }),
]);

export const TickSummary = z.object({
  outcome: z.enum(['ok', 'red', 'interrupted', 'timeout']),
  ticks: z.number().int(),
  eventsPath: z.string(),
  pad: z.string().optional(),
});

export function makeTick(o: { name?: [string, ...string[]]; timeout?: TimeoutSpec | null; heartbeatMs?: number } = {}) {
  return defineStreamCommand({
    name: o.name ?? ['test', 'tick'],
    summary: 'Test only: tick on the clock, then return a summary.',
    kind: 'read',
    needs: { repo: 'none' },
    timeout: o.timeout === undefined ? null : o.timeout,
    ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
    input: TickInput,
    event: TickEvent,
    summarySchema: TickSummary,
    outputMode: (input) => (input.stream ? 'ndjson' : 'final'),
    examples: [{ argv: 'ghx test tick --count 1 --interval-ms 0' }],
    exitCode: (s) => (s.outcome === 'red' ? ExitCode.CI_RED : ExitCode.OK),
    async *run(input, ctx) {
      let ticks = 0;
      for (let n = 1; n <= input.count; n++) {
        try {
          if (input.ignoreAbort) await new Promise(() => {});
          await ctx.clock.sleep(input.intervalMs, ctx.signal);
        } catch (e) {
          if (input.graceful && isAbort(e)) {
            const outcome = (e as GhxError).code === 'TIMEOUT' ? ('timeout' as const) : ('interrupted' as const);
            return { outcome, ticks, eventsPath: await ctx.events.path() };
          }
          throw e;
        }
        if (input.failAt === n) throw new GhxError('GH_FAILED', `tick ${n} failed`);
        if (input.warnAt === n) ctx.warn({ code: 'TICK_WARNING', message: `warning at ${n}` });
        if (input.badEventAt === n) {
          yield { type: 'tick', n: 'bad' } as unknown as z.input<typeof TickEvent>;
        } else if (input.reservedAt === n) {
          yield { type: 'summary', n } as unknown as z.input<typeof TickEvent>;
        } else {
          yield { type: 'tick' as const, n, ...(input.payloadBytes ? { pad: 'p'.repeat(input.payloadBytes) } : {}) };
        }
        ticks = n;
      }
      return {
        outcome: input.red ? ('red' as const) : ('ok' as const),
        ticks,
        eventsPath: await ctx.events.path(),
        ...(input.summaryBytes ? { pad: 's'.repeat(input.summaryBytes) } : {}),
      };
    },
  });
}
