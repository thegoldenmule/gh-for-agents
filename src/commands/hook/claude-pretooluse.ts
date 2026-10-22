// ghx hook claude-pretooluse (01 §7, 02 §11.0 "Enforcement", 03 M12.2): the opt-in Claude Code
// PreToolUse hook. It runs through spec.protocol, not the runner: Claude Code writes the event to stdin
// and reads the reply from stdout, so this is the one command that reads stdin without --input -.
// Setup and behaviour: docs/agents/hooks.md. The rules are in src/hook/rules.ts.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { runHook } from '../../hook/rules.ts';

const Reply = z.object({
  hookSpecificOutput: z
    .object({
      hookEventName: z.literal('PreToolUse'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      permissionDecision: z.enum(['ask', 'deny']).optional(),
      permissionDecisionReason: z.string().optional(),
    })
    .optional()
    .describe('Absent (no output at all) when the hook has nothing to say'),
});

export default defineCommand({
  name: ['hook', 'claude-pretooluse'],
  summary: 'Claude Code PreToolUse hook: background ghx ci wait, steer raw gh to ghx (stdin protocol)',
  description:
    'Reads the PreToolUse event JSON on stdin (the one command that does; Claude Code delivers it there) and ' +
    'prints a hook reply or nothing. A Bash `ghx ci wait` without run_in_background gets updatedInput with ' +
    'run_in_background: true and no permission decision. A gh CI polling loop (Bash or Monitor) or a gh ' +
    'command ghx wraps gets permissionDecision ask (GHX_HOOK_MODE=deny|ask|off; default ask) naming the ' +
    'ghx replacement. Fails open: any error or unparseable stdin exits 0 with no output. No gh calls. ' +
    'Register it with matcher Bash|Monitor (docs/agents/hooks.md).',
  kind: 'read',
  needs: { repo: 'none', config: 'none' },
  input: z.strictObject({}),
  output: Reply,
  examples: [
    {
      argv: 'ghx hook claude-pretooluse',
      note: 'Run by Claude Code with the event on stdin; settings: matcher "Bash|Monitor"',
    },
  ],
  protocol: runHook,
  // Never reached: runCli hands every call without --help/--schema to `protocol`.
  async run() {
    return {};
  },
});
