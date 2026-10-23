# Steering Claude Code toward ghx

The steering kit is opt-in. It has two parts that work separately or together:

1. **`permissions.deny` rules for raw gh writes.** These are a hard block with no code: Claude Code refuses the call before it runs. Writes have to go through ghx, which checks repo policy, validates input and pins the head SHA.
2. **`ghx hook claude-pretooluse`, an optional PreToolUse hook.** It does three things:
   - It denies a raw gh write that ghx wraps, in every mode, including forms with `-R`/`--repo` that the deny rules can't match.
   - It moves a foreground `ghx ci wait` to the background.
   - It suggests the ghx replacement when an agent reaches for a raw gh read or polls CI in a loop.

   Read suggestions use ask mode by default. The hook fails open.

## Install

`ghx install` writes both parts, plus the [CLAUDE.md snippet](claude-md-snippet.md), into your Claude Code settings. Look at what it would change first:

```sh
ghx install --dry-run   # unified diffs of each file; writes nothing
ghx install             # apply them
ghx doctor              # the install field shows what is installed
```

- **Where.** The default `--scope user` edits `settings.json` and `CLAUDE.md` in `$CLAUDE_CONFIG_DIR`, or in `~/.claude` when that is unset. `--scope project` edits `.claude/settings.json` and `CLAUDE.md` at the repository root.
- **What.** It merges the deny rules below into `permissions.deny`, skipping rules already there. It adds one PreToolUse entry for the hook, and replaces it on a re-install instead of adding another. It puts the snippet at the end of `CLAUDE.md` between `<!-- ghx:begin -->` and `<!-- ghx:end -->`, and replaces that block on a re-install. Every other setting stays as it was.
- **The hook runs by absolute path.** Its command is this machine's `node` and this checkout's `bin/ghx.js`, both quoted, such as `'/usr/local/bin/node' '/src/gh-for-agents/bin/ghx.js' hook claude-pretooluse`. It doesn't depend on the `PATH` Claude Code gives hooks. If you move the checkout or remove that node, `ghx doctor` warns `INSTALL_HOOK_STALE`; run `ghx install` again. Because of those paths, think twice before committing a `--scope project` install for other contributors.
- **Safe to re-run.** It refuses a `settings.json` that isn't valid JSON (`INSTALL_SETTINGS_INVALID`) and changes nothing. Before writing, it copies each file it changes to `<file>.bak-ghx-<time>`, then writes through a temp file and a rename. A second run with nothing to change reports `changed: []` and makes no backups.
- **Options.** `--no-deny`, `--no-hook` and `--no-snippet` leave a part out. `--hook-mode deny` sets `GHX_HOOK_MODE` (see Modes below), and `--hook-mode ask` removes it again. `--bin-dir ~/.local/bin` also links `ghx` there; it refuses to replace a file that isn't that link (`INSTALL_BIN_CONFLICT`), and the output says whether the directory is on your `PATH`.
- **Undo.** `ghx uninstall` (with the same `--scope`, and `--bin-dir` for the link) removes only what ghx added: its hook entry, those exact deny rules, `GHX_HOOK_MODE`, the marked block and the link. It also takes `--dry-run`.

## Settings

This is what `ghx install` merges in, for reference or to install by hand. To install by hand, paste it into a Claude Code settings file. Use `.claude/settings.json` to share it with a repo's contributors, `.claude/settings.local.json` for yourself in one repo, or `~/.claude/settings.json` for every repo. Merge it with what is already there. `ghx install` writes the hook command with absolute paths instead of a bare `ghx`.

```json
{
  "permissions": {
    "deny": [
      "Bash(gh pr create:*)",
      "Bash(gh pr edit:*)",
      "Bash(gh pr ready:*)",
      "Bash(gh pr merge:*)",
      "Bash(gh pr comment:*)",
      "Bash(gh pr review:*)",
      "Bash(gh pr close:*)",
      "Bash(gh run rerun:*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Monitor",
        "hooks": [{ "type": "command", "command": "ghx hook claude-pretooluse", "timeout": 5 }]
      }
    ]
  }
}
```

- **The deny rules** are the gh writes that ghx wraps, so each one has a validated replacement: `ghx pr merge`, `ghx pr create`, `ghx pr edit` (which also covers `ready`), `ghx pr review`, `ghx pr comment` (which also covers `close`, with `--close`) and `ghx ci rerun`. They are prefix rules, so they match the command as typed.
  - `gh pr reopen` is also wrapped (by `ghx ci retrigger`), but it is left out because reopening a PR is sometimes legitimate. Add `"Bash(gh pr reopen:*)"` if you want ghx to own it too.
- **Why you need both.** `permissions.deny` rules match the command as typed, from the start. gh also takes `-R`/`--repo` before the command words, so `Bash(gh pr merge:*)` does not match `gh -R o/r pr merge 12` or `gh --repo=o/r pr create`. You also can't write a prefix rule for every repo. The hook parses the command, finds the gh command wherever the repo flag sits, and denies these writes. The deny rules still block the plain forms when the hook isn't running: when it isn't installed, when `ghx` isn't on the hook's `PATH`, or when it fails open on an internal error.
- **Either part works alone**, but neither covers everything alone. Where both match, both deny.
- **To deny read suggestions instead of asking**, set the mode in the same file: `"env": { "GHX_HOOK_MODE": "deny" }`. Use `"off"` to silence suggestions and the `run_in_background` rewrite. Wrapped writes are denied in every mode.
- By hand, `ghx` has to be on the `PATH` that Claude Code runs hooks with. Otherwise use the absolute path to `bin/ghx.js`, as `ghx install` does.

## The hook

`ghx hook claude-pretooluse` reads the PreToolUse event JSON on stdin and answers on stdout.

**It reads stdin implicitly.** Every other ghx command takes JSON only from `--input <file>` or an explicit `--input -`. The hook is the one exception: Claude Code's hook protocol delivers the event on stdin and closes it. The hook reads at most 1 MB and gives up after 2 seconds, so a terminal or a pipe that never closes can't hang it.

It registers with matcher `Bash|Monitor` and handles these cases:

| Tool call | Reply |
|---|---|
| Bash or Monitor: a raw gh write that ghx wraps, with or without `-R`/`--repo` anywhere in it. These are `gh pr merge`, `gh pr create`, `gh pr edit`, `gh pr ready`, `gh pr review`, `gh pr comment`, `gh pr close` and `gh run rerun` (the deny list above), plus a `gh api` write to an endpoint a ghx command replaces, such as `gh api -X PUT repos/o/r/pulls/12/merge` | `deny` in **every** mode, including `off`, with a reason quoting the exact replacement, such as `ghx pr merge 12 -R o/r`. This check runs first, so chaining a write after `ghx ci wait` doesn't get it rewritten instead |
| Bash: a command that starts with `ghx ci wait` (after optional whitespace or `VAR=value` prefixes), without `run_in_background: true` | `updatedInput`: the whole tool input with `run_in_background: true`. **No `permissionDecision`**, so your permission rules still apply to the rewritten call |
| Bash or Monitor: gh polling CI in a loop. That means `gh pr checks`, `gh run watch`, `gh run list`, `gh run view`, a check-runs or statuses `gh api` GET, `ghx pr status` or `ghx ci wait`, inside `while`/`until`/`for`, `watch`, or next to a `sleep` | `ask`, with a reason naming `ghx ci wait <pr>` with `run_in_background: true`. The PR number is taken from the command when it is there |
| Monitor running `ghx ci wait` | `ask`: run it with the Bash tool and `run_in_background: true` instead |
| Bash or Monitor: a gh read that ghx wraps (`gh pr view`, `gh pr checks`, `gh run view --log`, `gh run watch`, …), or `gh pr reopen` | `ask`, with a reason quoting the exact replacement, such as `ghx pr status 3266` |
| Anything else, including allowlisted gh reads such as `gh pr diff` or a single `gh run list` | No output: the call goes ahead as usual |

The replacements come from two sources, so they stay in step with the commands:

- the passthrough refusal table in `src/passthrough/policy.ts`, which builds the exact replacement argv;
- every command spec's `replaces` list, generated into `src/hook/replaces.generated.json` by `pnpm docs:gen`.

**Modes.** `GHX_HOOK_MODE` picks how a read suggestion is delivered. It never changes the reply to a wrapped write, which is always `deny`:

| `GHX_HOOK_MODE` | Effect on suggestions |
|---|---|
| `ask` (default; also any unrecognised value) | `permissionDecision: "ask"`. You are asked whether to allow the raw command, and the reason tells the agent what to run instead |
| `deny` | `permissionDecision: "deny"`. The agent gets the reason and has to use ghx |
| `off` | No suggestions and no `run_in_background` rewrite. Wrapped writes are still denied |

The `run_in_background` rewrite never carries a decision in any mode.

**It fails open.** Any internal error, unparseable stdin, an unknown tool, or a missing `tool_input` exits 0 with no output, so a broken ghx never blocks the agent. It makes no gh or network calls, and loads only its own module, which keeps it well under the 100 ms budget.

**Version note.** `updatedInput` without a permission decision was verified on Claude Code 2.1.280. Re-check it after a Claude Code upgrade with `node scripts/spike-hook.ts`, which works in a temp directory and never touches your settings.
