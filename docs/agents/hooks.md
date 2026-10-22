# Steering Claude Code toward ghx

The steering kit is opt-in. It has two parts that work separately or together:

1. **`permissions.deny` rules for raw gh writes.** These are a hard block with no code: Claude Code refuses the call before it runs. Writes have to go through ghx, which checks repo policy, validates input and pins the head SHA.
2. **`ghx hook claude-pretooluse`, an optional PreToolUse hook.** It does two things:
   - It moves a foreground `ghx ci wait` to the background.
   - It suggests the ghx replacement when an agent reaches for a raw gh read or polls CI in a loop.

   It runs in ask mode by default and fails open.

Nothing here changes your settings for you. Copy the block you want into your own Claude Code settings file.

## The hook

`ghx hook claude-pretooluse` reads the PreToolUse event JSON on stdin and answers on stdout.

**It reads stdin implicitly.** Every other ghx command takes JSON only from `--input <file>` or an explicit `--input -`. The hook is the one exception: Claude Code's hook protocol delivers the event on stdin and closes it. The hook reads at most 1 MB and gives up after 2 seconds, so a terminal or a pipe that never closes can't hang it.

It registers with matcher `Bash|Monitor` and handles these cases:

| Tool call | Reply |
|---|---|
| Bash: a command that starts with `ghx ci wait` (after optional whitespace or `VAR=value` prefixes), without `run_in_background: true` | `updatedInput`: the whole tool input with `run_in_background: true`. **No `permissionDecision`**, so your permission rules still apply to the rewritten call |
| Bash or Monitor: gh polling CI in a loop. That means `gh pr checks`, `gh run watch`, `gh run list`, `gh run view`, a check-runs or statuses `gh api` GET, `ghx pr status` or `ghx ci wait`, inside `while`/`until`/`for`, `watch`, or next to a `sleep` | `ask`, with a reason naming `ghx ci wait <pr>` with `run_in_background: true`. The PR number is taken from the command when it is there |
| Monitor running `ghx ci wait` | `ask`: run it with the Bash tool and `run_in_background: true` instead |
| Bash or Monitor: a gh command that ghx wraps (`gh pr view`, `gh pr checks`, `gh run view --log`, `gh run watch`, `gh pr create`, `gh pr merge`, …) | `ask`, with a reason quoting the exact replacement, such as `ghx pr status 3266` |
| Anything else, including allowlisted gh reads such as `gh pr diff` or a single `gh run list` | No output: the call goes ahead as usual |

The replacements come from two sources, so they stay in step with the commands:

- the passthrough refusal table in `src/passthrough/policy.ts`, which builds the exact replacement argv;
- every command spec's `replaces` list, generated into `src/hook/replaces.generated.json` by `pnpm docs:gen`.

**Modes.** `GHX_HOOK_MODE` picks how a suggestion is delivered:

| `GHX_HOOK_MODE` | Effect |
|---|---|
| `ask` (default; also any unrecognised value) | `permissionDecision: "ask"`. You are asked whether to allow the raw command, and the reason tells the agent what to run instead |
| `deny` | `permissionDecision: "deny"`. The agent gets the reason and has to use ghx |
| `off` | No output at all, including no `run_in_background` rewrite |

The `run_in_background` rewrite never carries a decision in any mode.

**It fails open.** Any internal error, unparseable stdin, an unknown tool, or a missing `tool_input` exits 0 with no output, so a broken ghx never blocks the agent. It makes no gh or network calls, and loads only its own module, which keeps it well under the 100 ms budget.

**Version note.** `updatedInput` without a permission decision was verified on Claude Code 2.1.280 (03 §3.6). Re-check it after a Claude Code upgrade with `node scripts/spike-hook.ts`, which works in a temp directory and never touches your settings.
