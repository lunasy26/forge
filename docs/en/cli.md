**English** · [Русский](../ru/cli.md)

← [README](../../README.md)

# forge CLI

The hooks and the skills call `forge` for everything deterministic; you can run it yourself in Claude Code's Bash tool or, outside Claude Code, as `node /path/to/forge/bin/forge <command>`.

## Commands

| Command | What it does | Exit code |
|---|---|---|
| `forge init` | Shows the [stack](profile.md#stack-detection), the proposed profile and notes; writes nothing | 0 |
| `forge init --work local\|docs` | Chooses where [`forge:plan`](skills.md#forgeplan) keeps specs and plans: `local` — `.forge/work/` (the default), `docs` — `docs/specs/{slug}.md` and `docs/plans/{slug}.md`. Works with the preview and with `--yes`; without it `init` [proposes](profile.md#stack-detection) `docs` when `docs/specs/` or `docs/plans/` exists | 0; 2 — missing or unknown value |
| `forge init --yes [--force]` | Writes the profile and a copy of the schema, adds the [excludes](profile.md#what-init-writes) to `.git/info/exclude`; overwrites an existing profile only with `--force` | 0; 1 — the profile already exists |
| `forge state [get [key]]` | The whole [state](state.md#state-file) or a field by dotted path (`task.slug`) | 0 |
| `forge state set <key> <value> […]` | Changes fields in pairs; a value is read as JSON, otherwise as a string. Checked: `tier` (integer 0–3), `stage` (`spec`, `plan`, `execute`, `review`, `finish` or `null`), `mode` | 0; 2 — error |
| `forge state reset` | Resets `tier` (to 1), `stage`, `task`, `artifacts`, `failures`; the mode, the check result and the cursors stay | 0 |
| `forge mode [eco\|normal\|max]` | Shows or switches the [mode](routing.md#models-by-mode) (in the state) and prints its table | 0; 2 — unknown mode |
| `forge route <role> [--json]` | `role=… mode=… agent=… model=… effort=…` or the same as JSON ([how skills use it](routing.md#how-skills-dispatch-a-role)) | 0; 2 — no role given or unknown role |
| `forge route --table` | The current mode's table | 0 |
| `forge work <slug> [--json]` | `spec=… plan=…`, or `{spec, plan}` as JSON: the paths from the profile's [`work`](profile.md#profile-fields) with `{slug}` and `{date}` filled in | 0; 2 — no slug given, or it is not kebab-case (`add-login`) |
| `forge verify [--fast] [--json]` | Runs [`verify.steps`](hooks.md#verification-on-stop), records the result and the failure counter; `--json` prints `{ok, summary, failed, streak}` | 0 — passed; 1 — failed, no profile or no steps; 4 — skipped, there is no [Git Bash](hooks.md#which-shell-runs-the-commands) to run the steps (Windows) |
| `forge docs [--fix] [--json]` | Checks `AGENTS.md`/`CLAUDE.md` ([codes and levels](agent-docs.md#issue-codes)); `--fix` creates missing and empty `CLAUDE.md` files with the `@AGENTS.md` line; `--json` prints an array of `{code, level, path, message, fixable}` | 0 — no errors (warnings allowed); 1 — there is an error; 2 — unknown argument |
| `forge release --check [--json]` | Checks the changelog and the version files ([codes](releases.md#changelog-checks)); `--json` prints an array of `{code, level, path, message}` | 0 — no errors (warnings allowed); 1 — there is an error, or no `release` section; 2 — usage error |
| `forge release [major\|minor\|patch\|x.y.z] [--date YYYY-MM-DD] [--json]` | [Preview](releases.md#the-forge-release-command) of a release: level and reason, `current → next`, files, tag, commit; changes nothing | 0; 1 — nothing to release or another refusal, or no `release` section; 2 — usage error |
| `forge release <major\|minor\|patch\|x.y.z> --yes [--date YYYY-MM-DD] [--json]` | [Cuts the release](releases.md#what-apply-does-and-refuses): changelog, version files, commit `chore(release): x.y.z`, annotated tag; rolls back on failure; never pushes | 0; 1 — refused or failed (the files are restored); 2 — usage error, or no level given |
| `forge finish [--base <branch>] [--no-verify] [--json]` | [Whether the branch is ready to integrate](#forge-finish): checks, the full check over the files of the branch (recorded like `forge verify`) and the commands for the flow in `git.flow`; changes nothing in git | 0 — ready (warnings allowed); 1 — there is a ✗, or no profile; 2 — usage error |
| `forge doctor` | Node, plugin and project paths, [profile validity](profile.md#broken-profile), executables of the verification commands, git excludes, the [routing table](routing.md#routing-overrides), the [models setup](routing.md#checking-the-setup) (the `Models:` line: gateway, provider, alias mapping, forced subagent model and effort), [agent files](agent-docs.md#the-forge-docs-command), the [changelog](releases.md#changelog-checks) (with a `release` section), [Superpowers](../../README.md#superpowers-conflict), recent [hook errors](hooks.md#fail-open-and-fail-closed) | always 0 |
| `forge help`, `-h`, `--help`, no arguments | Help | 0 |

On Windows `forge doctor` also prints a Git Bash line, right after the profile line (only in a project with a profile): `✓ Git Bash: <path>` or `✗ Git Bash not found — install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH`. Git Bash is the shell that runs the [profile commands](hooks.md#which-shell-runs-the-commands); without it the check of command executables is skipped rather than reported as missing. On macOS and Linux there is no such line.

If `forge verify` cannot run the steps for lack of Git Bash, that is not a failure: it prints `SKIPPED: <step>: Git Bash not found, skipped` and the Git Bash message instead of the failure report, exits with code 4, leaves the failure counter alone and records `verify.ok: null` in the [state](state.md#state-file). With `--json` the object has `"ok": false` and `"shell_missing": true`.

An unknown command (or `state` subcommand) gives exit code 2, an internal CLI error gives 3. Errors are printed to stderr as `forge: …`.

If the reader closes the pipe early (`forge doctor | head -3`), forge stops writing quietly, without a stack trace, and exits with the command's own code: every command runs to the end before the closed pipe is noticed.

## `forge finish`

Gathers everything needed before integrating a finished branch and prints the exact commands; the command itself **never merges, pushes, deletes or fetches** — [`/forge:finish`](skills.md#forgefinish) runs the commands through Bash, so the [guard hooks](guards.md) see each of them and you approve each.

- **Base:** `--base <branch>`, otherwise `origin`'s default branch (`origin/HEAD`), otherwise the first existing branch of [`git.protected_branches`](profile.md#profile-fields) without `*`. It must be a local branch.
- **Blocks (✗):** a detached `HEAD` (`detached`), no base found (`no-base`), the current branch is the base (`on-base`), no commits ahead of the base (`no-commits`), changed tracked files (`dirty`), a failing check (`verify-failed`). After the first four nothing else is checked; with any ✗ the check doesn't run and no commands are printed.
- **Warns (!):** untracked files (`untracked`); the base moved ahead, so the merge result is untested (`behind`, suggesting `git rebase` or `git merge`); the local base is behind its upstream, so `behind` is measured against a stale base (`base-stale`, suggesting `git pull --ff-only` on the base; `git fetch` updates only `origin/<base>`); the check was skipped (`verify-skipped`, `no-verify-steps`, `verify-no-shell`); with a `release` section, the branch changed code outside `release.ignore` while `[Unreleased]` is empty (`unreleased-empty`); no flow chosen (`flow-unset`).
- **The check** runs `verify.steps` over the files of `git diff <base>...HEAD`, the full `test` rather than `test_fast`. Paths are relative to the project root: in a package with its own profile inside a larger repository only the package's files count.
- **merge commands, in this order:** `git switch <base>`, `git merge <branch>`; with `origin` — `git push origin <base>` (a base under `git.protected_branches` gets the note `base-protected`: the guard will refuse the push); if the branch has an upstream — `git push <remote> --delete <remote-branch>` (the remote and branch name it tracks); last, `git branch -d <branch>` — after the remote delete, because with an upstream behind the branch `git branch -d` refuses. When the base is checked out in another worktree — `git -C <path> merge <branch>`, the pushes with the same `-C`, and no local deletion (note `branch-in-worktree`; a dirty base worktree — `base-worktree-dirty`).
- **pr commands:** `git push -u origin <branch>`, `gh pr create --base <base> --head <branch> --fill`; notes `no-origin`, `no-gh`, `not-github`.
- The text shows the commands of the flow in `git.flow` (both lists when it is `null`). `--json` prints `{ok, branch, base, base_source, flow, ahead, behind, checks: [{id, level, message}], verify: {ok, summary, failed_step} | null, steps: {merge, pr}: [{cmd, cwd}], notes: [{id, flow, message}]}` — always with both flows' lists.

## Message language

The CLI answers in English or Russian. `FORGE_LANG=ru forge doctor` (or `en`) forces the language for one run and wins over the profile's [`language`](profile.md#profile-fields); without it the CLI uses the profile, then the language that the `Stop` hook remembered in [`state.lang`](state.md#state-file), then the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`), then English. The full order is on the [Hooks](hooks.md#message-language) page.

## Project root

The project root for the CLI and the hooks is `CLAUDE_PROJECT_DIR` if it is set; otherwise the nearest ancestor of the current directory with `.forge/profile.json` (not above the home directory and not above the first directory with `.git` — so a worktree inside the main checkout, such as `.claude/worktrees/<name>`, stays its own root); otherwise the root of the git repository; otherwise the current directory. If a linked worktree's root has no `.forge/profile.json`, the profile comes from the main checkout ([Profile in a worktree](profile.md#profile-in-a-worktree)), while state and the journal come from the worktree itself.
