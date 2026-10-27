# Steering Claude Code toward ghx

The steering kit is opt-in. It has two parts that work separately or together:

1. **`ghx hook claude-pretooluse`, a PreToolUse hook.** It does three things:
   - It moves a foreground `ghx ci wait` to the background, in any repo.
   - In a repo that has `.github/ghx.json`, it denies a raw gh write that ghx wraps, in every mode, including forms with `-R`/`--repo` that deny rules can't match.
   - In such a repo, it suggests the ghx replacement when an agent reaches for a raw gh read or polls CI in a loop.

   Elsewhere it says nothing about gh. Read suggestions are denied by default, so the agent gets the replacement and runs it without stopping for you. The hook fails open.
2. **`permissions.deny` rules for raw gh writes.** These are a hard block with no code: Claude Code refuses the call before it runs. Writes have to go through ghx, which checks repo policy, validates input and pins the head SHA.

**Enforcement is per repo.** A repo opts in by having `.github/ghx.json` (`ghx init` writes it). The hook checks for it on every call; deny rules can't. A `permissions.deny` rule has no condition: in `~/.claude/settings.json` it would block `gh pr merge` in every repo, configured or not. So `ghx install` at user scope (the default) installs only the hook and the CLAUDE.md block, and enforcement follows the repo. `--scope project` installs into one repo, where the deny rules are safe to add, and adds them too.

## Install

`ghx` is the npm package `@thegoldenmule/ghx` (Node.js 24 or later). `ghx install` writes the hook (and, at project scope, the deny rules), plus the [CLAUDE.md snippet](claude-md-snippet.md), into your Claude Code settings. Either let npx do both steps:

```sh
npx @thegoldenmule/ghx install
```

or install it globally first, and look at what it would change before applying it:

```sh
npm i -g @thegoldenmule/ghx
ghx install --dry-run   # unified diffs of each file; writes nothing
ghx install             # apply them
ghx doctor              # the install field shows what is installed
```

Upgrade with `npm update -g @thegoldenmule/ghx`. Uninstall with `ghx uninstall && npm rm -g @thegoldenmule/ghx`. To develop ghx itself, clone the repository, run `pnpm install`, and use `node bin/ghx.js` in place of `ghx`; an install from the checkout points the hook at the checkout.

- **From npx.** The npx cache is no place for a hook: npm prunes it, and running the hook through `npx` would cost about half a second per tool call and fail offline. So when `ghx install` runs from the npx cache (or under `npx`/`npm exec`), it first runs `npm i -g @thegoldenmule/ghx@<its own version>`, then runs `$(npm prefix -g)/bin/ghx install` with the same flags, and returns that output with a `handoff` field (the install command, the prefix, the global `ghx` and its arguments). The hook and any `--bin-dir` link then point at the global install. `--dry-run` runs only `npm prefix -g` and reports that plan. If npm can't write to its global prefix (`EACCES`), it stops with `INSTALL_NOT_WRITABLE`: use a Node.js you own (nvm or fnm), or run `npm i -g` yourself. Without npm it stops with `ENV_NPM_MISSING`, and other npm failures are `INSTALL_GLOBAL_FAILED` with npm's output in `details`. `--no-global` refuses to install from the npx cache at all, and says why.

- **Where.** The default `--scope user` edits `settings.json` and `CLAUDE.md` in `$CLAUDE_CONFIG_DIR`, or in `~/.claude` when that is unset. `--scope project` edits `.claude/settings.local.json` and `CLAUDE.md` at the repository root. It uses `settings.local.json`, Claude Code's per-machine, uncommitted settings file, because the hook command holds this machine's paths. If git doesn't ignore that file, the output warns `SETTINGS_LOCAL_NOT_IGNORED`; add `.claude/settings.local.json` to `.gitignore` yourself, since ghx won't edit it. `ghx doctor` reads both `.claude/settings.local.json` and, in case you installed by hand, `.claude/settings.json`, under `install.project.shared`.
- **What.** It adds one PreToolUse entry for the hook, and replaces it on a re-install instead of adding another. At project scope it also merges the deny rules below into `permissions.deny`, skipping rules already there. At user scope it adds none, and a re-install removes the deny rules an earlier ghx install added there (warning `INSTALL_DENY_REMOVED`), never ones you added yourself. `ghx doctor` matches this: `install.project.deny` has `expected: true` and lists any `missing` rules, while `install.user.deny` has `expected: false`, the ghx-shaped rules `present` anyway, and `ghxAdded`, the ones an earlier ghx install left; it warns `INSTALL_DENY_LEGACY` only for those. It puts the snippet at the end of `CLAUDE.md` between `<!-- ghx:begin -->` and `<!-- ghx:end -->`, and replaces that block on a re-install. Every other setting stays as it was.
- **The hook runs by absolute path.** Its command is this machine's `node` and the installed ghx's `bin/ghx.js` (in the global npm install, or in a checkout), both quoted, such as `'/usr/local/bin/node' '/usr/local/lib/node_modules/@thegoldenmule/ghx/bin/ghx.js' hook claude-pretooluse`. It doesn't depend on the `PATH` Claude Code gives hooks. If you remove that ghx or that node, `ghx doctor` warns `INSTALL_HOOK_STALE`; run `ghx install` again. If the hook still runs but runs another ghx version than the one running `ghx doctor` (by the `package.json` beside the hook's `bin/ghx.js`), doctor warns `INSTALL_HOOK_VERSION_MISMATCH`; if it runs another `node`, it warns `INSTALL_HOOK_NODE_MISMATCH`. Both happen after an upgrade or a Node switch: run `ghx install` again with the ghx and node you mean to keep. `install.<scope>.hook.version` and `.node` show what the hook runs. Because of those paths, `--scope project` writes the uncommitted `settings.local.json`; don't copy the hook into a shared `settings.json`.
- **Safe to re-run.** It refuses a settings file that isn't valid JSON (`INSTALL_SETTINGS_INVALID`) and changes nothing. It checks that it can write every file, directory and backup before writing any, and refuses a read-only file or directory (`INSTALL_NOT_WRITABLE`) instead of replacing it or stopping halfway. A symlinked settings file or `CLAUDE.md` is written through to its target; a link whose target doesn't exist is refused rather than replaced with a regular file. A file's BOM and CRLF line endings are kept. When a settings file has hand formatting that ghx can't reproduce (inline arrays, say), the rewrite reformats it and warns `INSTALL_REFORMATTED`; uninstall still restores the original bytes while the file is unchanged. Before writing, it copies each file it changes to `ghx-install/<scope>-<hash>/backups/<name>.bak-ghx-<time>` under `$CLAUDE_CONFIG_DIR` (or `~/.claude`), never into the repository, and reports each copy's path in `files[].backup`. Then it writes through a temp file and a rename. A second run with nothing to change reports `changed: []` and makes no backups.
- **Options.** `--no-hook` and `--no-snippet` leave a part out, and `--no-deny` leaves the deny rules out at project scope. `--deny` at user scope is refused (`VALIDATION`). `--hook-mode ask` sets `GHX_HOOK_MODE` (see Modes below), and `--hook-mode deny` removes it again. `--bin-dir ~/.local/bin` also links `ghx` there; it refuses to replace a file that isn't that link (`INSTALL_BIN_CONFLICT`), and the output says whether the directory is on your `PATH`.
- **Undo.** `ghx uninstall` (with the same `--scope`; the link a `--bin-dir` install made is in its record, so `--bin-dir` is needed only for another link; and `--no-snippet` to keep the CLAUDE.md block) removes only what ghx added: its hook entry, the deny rules it added, the `GHX_HOOK_MODE` it set, the settings containers it created, the marked block and the link. Install records what it added in `ghx-install/<scope>-<hash>/manifest.json` under `$CLAUDE_CONFIG_DIR` (or `~/.claude`), never in the settings file or the repository, so a deny rule or `GHX_HOOK_MODE` you had before stays. If a file is still exactly what ghx last wrote, uninstall puts back the original bytes from the backup, formatting and all; if you've edited it since, it removes ghx's entries and keeps your edits. An install from before that record is judged from its backups. Both scopes need `HOME` or `CLAUDE_CONFIG_DIR` for it. It also takes `--dry-run`.

## Settings

This is what `ghx install --scope project` merges in, for reference or to install by hand. To install by hand, paste it into a Claude Code settings file. Use `.claude/settings.json` to share it with a repo's contributors, or `.claude/settings.local.json` for yourself in one repo. For `~/.claude/settings.json`, leave out `permissions`: deny rules there apply to every repo, while the hook enforces only where `.github/ghx.json` exists. Merge it with what is already there. `ghx install` writes the hook command with absolute paths instead of a bare `ghx`.

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

- **The deny rules** are the gh writes that ghx wraps, so each one has a validated replacement: `ghx pr merge`, `ghx pr create`, `ghx pr edit` (which also covers `ready` for a PR with a ghx block; one without needs `"adopt": true` and the full object), `ghx pr review`, `ghx pr comment` (which also covers `close`, with `--close`) and `ghx ci rerun`. They are prefix rules, so they match the command as typed.
  - `gh pr reopen` is also wrapped (by `ghx ci retrigger`), but it is left out because reopening a PR is sometimes legitimate. Add `"Bash(gh pr reopen:*)"` if you want ghx to own it too.
- **Why a repo wants both.** `permissions.deny` rules match the command as typed, from the start. gh also takes `-R`/`--repo` before the command words, so `Bash(gh pr merge:*)` does not match `gh -R o/r pr merge 12` or `gh --repo=o/r pr create`. You also can't write a prefix rule for every repo. The hook parses the command, finds the gh command wherever the repo flag sits, and denies these writes. The deny rules still block the plain forms when the hook isn't running: when it isn't installed, when `ghx` isn't on the hook's `PATH`, or when it fails open on an internal error.
- **Either part works alone**, but neither covers everything alone. Where both match, both deny.
- **To ask about read suggestions instead of denying them**, set the mode in the same file: `"env": { "GHX_HOOK_MODE": "ask" }`. Use `"off"` to silence suggestions and the `run_in_background` rewrite. Wrapped writes are denied in every mode.
- By hand, `ghx` has to be on the `PATH` that Claude Code runs hooks with. Otherwise use the absolute path to `bin/ghx.js`, as `ghx install` does.

## The hook

`ghx hook claude-pretooluse` reads the PreToolUse event JSON on stdin and answers on stdout.

**It reads stdin implicitly.** Every other ghx command takes JSON only from `--input <file>` or an explicit `--input -`. The hook is the one exception: Claude Code's hook protocol delivers the event on stdin and closes it. The hook reads at most 1 MB and gives up after 2 seconds, so a terminal or a pipe that never closes can't hang it.

It registers with matcher `Bash|Monitor`.

**It enforces only in configured repos.** It reads `cwd` from the event and walks up to the nearest directory with a `.git` entry (a directory, or the file a worktree or submodule has). If that checkout has `.github/ghx.json`, every row below applies. If not, only the `ghx ci wait` rewrite does, and gh reads and writes get no output. A missing `cwd`, or no checkout above it, counts as not configured. The walk is filesystem only (no gh, no git process) and takes well under a millisecond.

In a configured repo it handles these cases:

| Tool call | Reply |
|---|---|
| Bash or Monitor: a raw gh write that ghx wraps, with or without `-R`/`--repo` anywhere in it. These are `gh pr merge`, `gh pr create`, `gh pr edit`, `gh pr ready`, `gh pr review`, `gh pr comment`, `gh pr close` and `gh run rerun` (the deny list above), plus a `gh api` write to an endpoint a ghx command replaces, such as `gh api -X PUT repos/o/r/pulls/12/merge` | `deny` in **every** mode, including `off`, with a reason quoting the exact replacement, such as `ghx pr merge 12 -R o/r`. This check runs first, so chaining a write after `ghx ci wait` doesn't get it rewritten instead |
| Bash: a command that starts with `ghx ci wait` (after optional whitespace or `VAR=value` prefixes), without `run_in_background: true` | `updatedInput`: the whole tool input with `run_in_background: true`. **No `permissionDecision`**, so your permission rules still apply to the rewritten call |
| Bash or Monitor: gh polling CI in a loop. That means `gh pr checks`, `gh run watch`, `gh run list`, `gh run view`, a check-runs or statuses `gh api` GET, `ghx pr status` or `ghx ci wait`, inside `while`/`until`, `watch`, or next to a `sleep` (a `for` over a fixed list, such as one status per PR, is not polling on its own) | `deny`, with a reason naming `ghx ci wait <pr>` with `run_in_background: true`. The PR number, or `run:<id>` for a `gh run` command, is taken from the command when it is there |
| Monitor running `ghx ci wait` | `deny`: run it with the Bash tool and `run_in_background: true` instead |
| Bash or Monitor: a gh read that ghx wraps (`gh pr view`, `gh pr checks`, `gh run view --log`, `gh run watch`, …), or `gh pr reopen` | `deny`, with a reason quoting the exact replacement, such as `ghx pr status 3266` or `ghx ci why run:123` |
| Anything else, including allowlisted gh reads such as `gh pr diff` or a single `gh run list` | No output: the call goes ahead as usual |

The replacements come from two sources, so they stay in step with the commands:

- the passthrough refusal table in `src/passthrough/policy.ts`, which builds the exact replacement argv;
- every command spec's `replaces` list, generated into `src/hook/replaces.generated.json` by `pnpm docs:gen`.

**Modes.** `GHX_HOOK_MODE` picks how a read suggestion is delivered. It never changes the reply to a wrapped write, which is always `deny`:

| `GHX_HOOK_MODE` | Effect on suggestions |
|---|---|
| `deny` (default; also any unrecognised value) | `permissionDecision: "deny"`. The agent gets the reason and runs the ghx replacement, with no one in the loop |
| `ask` | `permissionDecision: "ask"`. You get a permission dialog showing the reason; the agent waits on it and sees the reason only if you refuse. In auto mode and in background subagents, that stalls the run until someone answers |
| `off` | No suggestions and no `run_in_background` rewrite. Wrapped writes are still denied |

The `run_in_background` rewrite never carries a decision in any mode.

**It fails open.** Any internal error, unparseable stdin, an unknown tool, a missing `tool_input`, or a `cwd` it can't resolve to a configured repo exits 0 with no output (for gh calls), so a broken ghx never blocks the agent. It makes no gh or network calls, and loads only its own module, which keeps it well under the 100 ms budget.

**Version note.** `updatedInput` without a permission decision was verified on Claude Code 2.1.280. Re-check it after a Claude Code upgrade with `node scripts/spike-hook.ts`, which works in a temp directory and never touches your settings.
