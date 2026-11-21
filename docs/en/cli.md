**English** · [Русский](../ru/cli.md)

← [README](../../README.md)

# forge CLI

The hooks and the skills call `forge` for everything deterministic; you can run it yourself in Claude Code's Bash tool or, outside Claude Code, as `node /path/to/forge/bin/forge <command>`.

## Commands

| Command | What it does | Exit code |
|---|---|---|
| `forge init` | Shows the [stack](profile.md#stack-detection), the proposed profile and notes; writes nothing | 0 |
| `forge init --yes [--force]` | Writes the profile and a copy of the schema, adds the [excludes](profile.md#what-init-writes) to `.git/info/exclude`; overwrites an existing profile only with `--force` | 0; 1 — the profile already exists |
| `forge state [get [key]]` | The whole [state](state.md#state-file) or a field by dotted path (`task.slug`) | 0 |
| `forge state set <key> <value> […]` | Changes fields in pairs; a value is read as JSON, otherwise as a string. Checked: `tier` (integer 0–3), `stage` (`spec`, `plan`, `execute`, `review`, `finish` or `null`), `mode` | 0; 2 — error |
| `forge state reset` | Resets `tier` (to 1), `stage`, `task`, `artifacts`, `failures`; the mode, the check result and the cursors stay | 0 |
| `forge mode [eco\|normal\|max]` | Shows or switches the [mode](routing.md#models-by-mode) (in the state) and prints its table | 0; 2 — unknown mode |
| `forge route <role> [--json]` | `role=… mode=… agent=… model=… effort=…` or the same as JSON ([how skills use it](routing.md#how-skills-dispatch-a-role)) | 0; 2 — no role given or unknown role |
| `forge route --table` | The current mode's table | 0 |
| `forge verify [--fast] [--json]` | Runs [`verify.steps`](hooks.md#verification-on-stop), records the result and the failure counter; `--json` prints `{ok, summary, failed, streak}` | 0 — passed; 1 — failed, no profile or no steps |
| `forge docs [--fix] [--json]` | Checks `AGENTS.md`/`CLAUDE.md` ([codes and levels](agent-docs.md#issue-codes)); `--fix` creates missing and empty `CLAUDE.md` files with the `@AGENTS.md` line; `--json` prints an array of `{code, level, path, message, fixable}` | 0 — no errors (warnings allowed); 1 — there is an error; 2 — unknown argument |
| `forge release --check [--json]` | Checks the changelog and the version files ([codes](releases.md#changelog-checks)); `--json` prints an array of `{code, level, path, message}` | 0 — no errors (warnings allowed); 1 — there is an error, or no `release` section; 2 — usage error |
| `forge release [major\|minor\|patch\|x.y.z] [--date YYYY-MM-DD] [--json]` | [Preview](releases.md#the-forge-release-command) of a release: level and reason, `current → next`, files, tag, commit; changes nothing | 0; 1 — nothing to release or another refusal, or no `release` section; 2 — usage error |
| `forge release <major\|minor\|patch\|x.y.z> --yes [--date YYYY-MM-DD] [--json]` | [Cuts the release](releases.md#what-apply-does-and-refuses): changelog, version files, commit `chore(release): x.y.z`, annotated tag; rolls back on failure; never pushes | 0; 1 — refused or failed (the files are restored); 2 — usage error, or no level given |
| `forge doctor` | Node, plugin and project paths, [profile validity](profile.md#broken-profile), executables of the verification commands, git excludes, the [routing table](routing.md#routing-overrides), the [models setup](routing.md#checking-the-setup) (the `Models:` line: gateway, provider, alias mapping, forced subagent model and effort), [agent files](agent-docs.md#the-forge-docs-command), the [changelog](releases.md#changelog-checks) (with a `release` section), [Superpowers](../../README.md#superpowers-conflict), recent [hook errors](hooks.md#fail-open-and-fail-closed) | always 0 |
| `forge help`, `-h`, `--help`, no arguments | Help | 0 |

An unknown command (or `state` subcommand) gives exit code 2, an internal CLI error gives 3. Errors are printed to stderr as `forge: …`.

## Message language

The CLI answers in English or Russian. `FORGE_LANG=ru forge doctor` (or `en`) forces the language for one run and wins over the profile's [`language`](profile.md#profile-fields); without it the CLI uses the profile, then the language that the `Stop` hook remembered in [`state.lang`](state.md#state-file), then the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`), then English. The full order is on the [Hooks](hooks.md#message-language) page.

## Project root

The project root for the CLI and the hooks is `CLAUDE_PROJECT_DIR` if it is set; otherwise the nearest ancestor of the current directory with `.forge/profile.json` (not above the home directory and not above the first directory with `.git` — so a worktree inside the main checkout, such as `.claude/worktrees/<name>`, stays its own root); otherwise the root of the git repository; otherwise the current directory. If a linked worktree's root has no `.forge/profile.json`, the profile comes from the main checkout ([Profile in a worktree](profile.md#profile-in-a-worktree)), while state and the journal come from the worktree itself.
