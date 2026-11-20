**English** · [Русский](README.ru.md)

# forge

A Claude Code plugin that gives a session process discipline through hooks, not prompt pleading: git and secret guards, format and lint after edits, verification before a turn ends, a per-project profile, and model and effort routing for role subagents.

[![test](https://github.com/lunasy26/forge/actions/workflows/test.yml/badge.svg)](https://github.com/lunasy26/forge/actions/workflows/test.yml)
[![version](https://img.shields.io/badge/version-0.3.0-blue)](CHANGELOG.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-339933)](package.json)
[![dependencies: zero](https://img.shields.io/badge/dependencies-zero-brightgreen)](package.json)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://code.claude.com/docs/en/plugins)

Whatever must always or never happen is done by hooks and the `forge` CLI; skills stay where judgment is needed.

Without `.forge/profile.json` only the [Bash guard](#bash-guard) and the [file guard](#file-guard) run, with built-in defaults (branches `main` and `master`, `.env*` files and keys are protected). There is no lint and no auto-verification, and the hooks write nothing into the repository. In a git repository without a profile, session start adds one line suggesting `/forge:init`; outside a git repository, nothing.

> forge speaks Russian: CLI output, hook reasons (prefixed `forge:`) and profile errors. This README quotes those messages verbatim and translates them in parentheses.

## Contents

- [Why forge](#why-forge)
- [Features](#features)
- [Session lifecycle](#session-lifecycle)
- [Requirements](#requirements)
- [Installation](#installation)
  - [From GitHub](#from-github)
  - [Local development](#local-development)
  - [Superpowers conflict](#superpowers-conflict)
- [Quick start](#quick-start)
  - [What init writes](#what-init-writes)
- [Hooks](#hooks)
  - [Hook table](#hook-table)
  - [Fail-open and fail-closed](#fail-open-and-fail-closed)
- [Bash guard](#bash-guard)
  - [How a command is read](#how-a-command-is-read)
  - [Guard rules](#guard-rules)
  - [Abbreviated long options](#abbreviated-long-options)
  - [Recursive rm](#recursive-rm)
  - [Protected branches](#protected-branches)
- [File guard](#file-guard)
  - [Pattern syntax](#pattern-syntax)
- [Format and lint](#format-and-lint)
- [Verification on Stop](#verification-on-stop)
  - [Failure streak](#failure-streak)
- [Agent files](#agent-files)
  - [Layout](#layout)
  - [The forge docs command](#the-forge-docs-command)
  - [Issue codes](#issue-codes)
  - [Fixing and JSON output](#fixing-and-json-output)
- [Agent docs reminder](#agent-docs-reminder)
  - [What counts as a change](#what-counts-as-a-change)
  - [What clears a reminder](#what-clears-a-reminder)
  - [Reminder memory](#reminder-memory)
  - [Order and when it stays quiet](#order-and-when-it-stays-quiet)
- [Releases and CHANGELOG](#releases-and-changelog)
  - [Turning it on](#turning-it-on)
  - [The forge release command](#the-forge-release-command)
  - [Choosing the level](#choosing-the-level)
  - [What apply does and refuses](#what-apply-does-and-refuses)
  - [Version files](#version-files)
  - [Changelog checks](#changelog-checks)
  - [Reminder about an empty Unreleased](#reminder-about-an-empty-unreleased)
  - [Release flow in Claude](#release-flow-in-claude)
- [Session start context](#session-start-context)
- [Profile](#profile)
  - [Example](#example)
  - [Profile fields](#profile-fields)
  - [Broken profile](#broken-profile)
  - [Stack detection](#stack-detection)
- [Model routing](#model-routing)
  - [Roles](#roles)
  - [Models by mode](#models-by-mode)
  - [How skills dispatch a role](#how-skills-dispatch-a-role)
  - [Retry ladder](#retry-ladder)
  - [Invariants](#invariants)
  - [Routing overrides](#routing-overrides)
- [Skills](#skills)
  - [Plan task format](#plan-task-format)
- [forge CLI](#forge-cli)
  - [Commands](#commands)
  - [Project root](#project-root)
- [Files and state](#files-and-state)
  - [The .forge directory](#the-forge-directory)
  - [State file](#state-file)
  - [Edit journal](#edit-journal)
- [Development](#development)
  - [Repository layout](#repository-layout)
  - [Running tests](#running-tests)
  - [Testing hooks](#testing-hooks)
  - [Adding a guard rule](#adding-a-guard-rule)
  - [Adding a role](#adding-a-role)
- [Limitations](#limitations)
  - [Guards](#guards)
  - [Edits outside edit tools](#edits-outside-edit-tools)
  - [Reminder and forge docs](#reminder-and-forge-docs)
  - [Releases](#releases)
  - [Other](#other)
- [Links](#links)
  - [Project documents](#project-documents)
  - [Claude Code documentation](#claude-code-documentation)
  - [Conventions](#conventions)
- [License](#license)

## Why forge

- **Mechanics instead of pleading.** Rules that must hold every time live in hooks and a CLI, not in capitalised prompt text that the model may or may not follow.
- **A safety net from the first session.** Push to `main`, force push, `--no-verify`, edits to `.env` and keys are stopped even in a project that was never set up.
- **A turn doesn't end on red.** After edits, verification runs before Claude finishes; a failure goes back to Claude, the second one in a row escalates to a `debugger` role, and the third releases the session instead of looping.
- **The right model for each job.** Every subagent role gets a model and effort from a table, and one switch (`eco`, `normal`, `max`) moves the whole table.
- **Quiet by default.** Allowed actions print nothing, session start adds at most 600 characters, and without a profile nothing is written to the repository.

[↑ Back to contents](#contents)

## Features

| Feature | What you get |
|---|---|
| [Bash guard](#bash-guard) | `deny` for `git push` to protected branches, force push, `--mirror`, `--no-verify`; `ask` before `git reset --hard`, `git push --all` and `rm -r` outside the project. Sees through `bash -c`, `eval` and `$(…)` |
| [File guard](#file-guard) | `deny` for edit tools on `.env*`, keys and paths from `protected_files` |
| [Format and lint](#format-and-lint) | After each batch of tool calls, `format` and `lint` run on the files just edited; failures reach Claude as context |
| [Verification on Stop](#verification-on-stop) | `verify.steps` run before a turn ends; a failure keeps the turn going, the second in a row calls in `debugger`, the third lets go |
| [Agent files](#agent-files) | `AGENTS.md` is the source, `CLAUDE.md` imports it; `forge docs` checks the layout, `/forge:docs` writes the files. New in 0.3.0 |
| [Agent docs reminder](#agent-docs-reminder) | When a turn changes commands or project structure, Claude is asked once to check `AGENTS.md`/`CLAUDE.md`. New in 0.3.0 |
| [Releases and CHANGELOG](#releases-and-changelog) | Opt-in `release` section: `forge release` checks a Keep a Changelog file, previews and cuts a version (changelog, version files, commit, tag; never pushes); a reminder when code changed but `[Unreleased]` is empty; `/forge:release`. New in 0.4.0 |
| [Session start context](#session-start-context) | Up to 600 characters: mode, checks, active task, warnings |
| [Profile](#profile) | `.forge/profile.json` with a JSON Schema; stack detection for Node/TS, Python, Swift, Go and Rust |
| [Model routing](#model-routing) | Model and effort per subagent role from the `eco`/`normal`/`max` table, checked by invariants |
| [Skills](#skills) | `/forge:init`, `/forge:mode`, `/forge:plan`, `/forge:execute`, `/forge:review`, `/forge:docs`, `/forge:release` |
| [forge CLI](#forge-cli) | `init`, `state`, `mode`, `route`, `verify`, `docs`, `release`, `doctor` |

[↑ Back to contents](#contents)

## Session lifecycle

```mermaid
flowchart TD
    S["SessionStart<br/>context line, agent-docs line"] --> W(["Claude works"])
    W -- "tool call" --> G{"PreToolUse<br/>Bash guard, file guard"}
    G -- "deny: reason goes to Claude" --> W
    G -- "ask: runs if the user confirms" --> T["Tool runs"]
    G -- "allowed, silent" --> T
    T --> J["PostToolUse<br/>edit tools append to the edit journal"]
    J --> B["PostToolBatch<br/>format, then lint"]
    B -- "failure as additionalContext, or ok" --> W
    W -- "tries to end the turn" --> V{"Stop<br/>verify.steps"}
    V -- "fail: block<br/>2nd in a row: debugger hint" --> W
    V -- "3rd failure on a repeated stop:<br/>let go, tell the user" --> E(["Turn ends"])
    V -- "pass or nothing new" --> R{"Reminders over one edit window<br/>agent docs, empty Unreleased"}
    R -- "commands or structure changed, or code changed<br/>with Unreleased empty:<br/>one block with every reason" --> W
    R -- "nothing to remind" --> E
```

[SessionStart](#session-start-context) adds a short context. Every tool call passes the [Bash guard](#bash-guard) or the [file guard](#file-guard). Edits are journaled and [formatted and linted](#format-and-lint) after each batch. When Claude tries to finish, [verification](#verification-on-stop) runs, then the one-shot reminders over one shared window of edits: the [agent docs reminder](#agent-docs-reminder) and, if the profile has a `release` section, the [reminder about an empty `[Unreleased]`](#reminder-about-an-empty-unreleased). If both fire, Claude gets one block with both reasons.

[↑ Back to contents](#contents)

## Requirements

- Node.js ≥ 20 on `PATH`. No dependencies.
- `git` and `/bin/sh`: verification commands run through it. macOS and Linux are supported.
- Claude Code with plugin hooks, including the `PostToolBatch` event, and the plugin's `bin/` directory on the Bash tool's `PATH`.

[↑ Back to contents](#contents)

## Installation

### From GitHub

The repository is public, no credentials needed. In Claude Code:

```
/plugin marketplace add lunasy26/forge
/plugin install forge@forge-dev
```

`forge-dev` is the marketplace name from `.claude-plugin/marketplace.json`: the repository is its own marketplace. See [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) in the Claude Code docs.

### Local development

```bash
claude --plugin-dir /path/to/forge
```

While the plugin is enabled, the `forge` CLI is available in Claude Code's Bash tool. Outside Claude Code: `node /path/to/forge/bin/forge <command>`.

### Superpowers conflict

forge replaces Superpowers and conflicts with it. If `superpowers@…` is enabled in `enabledPlugins` (read from `~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`, then the project's `.claude/settings.json` and `.claude/settings.local.json`; a later file overrides an earlier one), forge warns at [session start](#session-start-context) and in [`forge doctor`](#commands). Disable it through `/plugin`.

[↑ Back to contents](#contents)

## Quick start

```
/forge:init → forge doctor → /forge:docs → /forge:mode, /forge:plan → /forge:execute → /forge:review
```

1. **`/forge:init`** in the project. The skill runs `forge init` (preview only) and shows the stack, verification steps, `verify.on_stop`, protected branches and risky paths. It asks only about what it couldn't [detect](#stack-detection), then writes the [profile](#profile) (`forge init --yes`) and runs `forge doctor`.
2. **`forge doctor`.** Its `✗` lines are what to fix, for example a verification command that isn't on `PATH`.
3. **`/forge:docs`**, if the project has no `AGENTS.md`: `/forge:init` offers it at the end. It drafts the [agent files](#agent-files) from the project and writes nothing without your yes. If only the `CLAUDE.md` links are missing, `/forge:init` offers `forge docs --fix` instead.
4. **Day to day.** Small edits — work as usual: [lint](#format-and-lint) and [verification](#verification-on-stop) fire on their own. `/forge:mode eco|normal|max` picks the [model table](#models-by-mode).
5. **A feature across several files**: `/forge:plan` (spec and task plan, waits for your yes), then `/forge:execute`, then `/forge:review`. See [Skills](#skills).

### What init writes

| Path | Contents | In git |
|---|---|---|
| `.forge/profile.json` | project [profile](#profile) | your call |
| `.forge/profile.schema.json` | copy of the schema; the profile points to it with `"$schema"` for editor completion | together with the profile |
| `.git/info/exclude` | lines `.forge/state.json`, `.forge/edits.jsonl`, `.forge/work/`, `.forge/log/` | — |

The excludes go to `info/exclude` of the common git directory (so they apply in every worktree); the project's `.gitignore` is not touched. A committed profile gives everyone who has forge the same checks and guards; commit it together with `profile.schema.json`.

[↑ Back to contents](#contents)

## Hooks

Each hook is `node hooks/<name>.mjs`: it reads the event JSON on stdin and writes its answer to stdout. Hook events and output fields are described in the Claude Code [hooks reference](https://code.claude.com/docs/en/hooks).

### Hook table

| Event | Matcher | Script | What it does | Timeout, s |
|---|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | `session-start.mjs` | [Short context](#session-start-context): mode, tier, checks, active task, warnings, a line about the root agent files | 10 |
| `PreToolUse` | `Bash` | `pre-bash.mjs` | [Bash guard](#bash-guard) for git and `rm -r`: `deny` or `ask` with a reason | 10 |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `pre-edit.mjs` | [File guard](#file-guard): `deny` for `protected_files` | 10 |
| `PostToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `post-edit.mjs` | Appends the path to the [edit journal](#edit-journal) `.forge/edits.jsonl`; does nothing without a profile | 10 |
| `PostToolBatch` | — | `post-batch.mjs` | [`format` and `lint`](#format-and-lint) on the files changed since the last run | 180 |
| `Stop` | — | `stop.mjs` | [`verify.steps`](#verification-on-stop) if there were edits since the last check; then, over one window of edits, the [reminder about agent files](#agent-docs-reminder) (commands or structure changed) and the [reminder about an empty `[Unreleased]`](#reminder-about-an-empty-unreleased) (only with a `release` section); both reasons go into one block | 600 |

When an action is allowed, the guard hooks print nothing, and Claude Code's normal permissions apply. `deny` rejects the call and passes the reason to Claude; `ask` asks the user to confirm. Reasons are in Russian and start with `forge:`, for example:

```
forge: git push --force запрещён. Для своей ветки используй --force-with-lease.
```

("git push --force is forbidden. For your own branch use --force-with-lease.")

### Fail-open and fail-closed

On an internal error a hook writes it to the log and exits with code 0 and no output (fail-open): a forge failure never blocks your work. The log is `.forge/log/errors.log` if the project has `.forge/`, otherwise `forge-errors.log` in the system temp directory; [`forge doctor`](#commands) shows the latest errors.

The exception is the guard hooks `pre-bash` and `pre-edit`: if the check itself breaks, they answer `ask` and write the error to the same log (fail-closed). The reason is `forge: внутренняя ошибка проверки … не могу убедиться, что она безопасна. Подтверди.` ("internal check error … can't make sure it's safe. Confirm."; for `pre-edit` it ends with «не могу убедиться, что правка разрешена», "can't make sure the edit is allowed"). Unreadable JSON on stdin still means a silent exit: there is nothing to check.

[↑ Back to contents](#contents)

## Bash guard

### How a command is read

This is not a full shell parser but a conservative split:

- the line is split into simple commands at `;`, `&&`, `||`, `|`, `&`, `(`, `)` and newlines; quotes are removed, comments and redirection targets don't count as arguments;
- before the command name, assignments (`FOO=1`), the wrappers `sudo`, `env`, `command`, `exec`, `nohup`, `time`, `nice`, `builtin` with their `-…` flags, and the words `if`, `then`, `else`, `elif`, `while`, `until`, `do`, `{`, `}`, `!` are dropped; the name is compared by basename (`/usr/bin/git` is `git`);
- `cd <dir>` changes the directory for the following commands on the same line (this matters for `rm -r` paths and for the current branch); `git -C <dir>` does it for that one command;
- the string after `bash`/`sh`/`zsh`/`dash`/`ksh` with the `-c` flag is checked as a separate command. `c` may sit in any cluster of short flags (`-lc`, `-xc`, `-cx`), `-o`/`-O` take a value (`-o pipefail`), so do `--rcfile`/`--init-file`, and `--` is skipped; the script is the first argument after the flags. The arguments of `eval` (without a leading `--`) are joined with spaces and checked the same way;
- commands inside the substitutions `$(…)`, `` `…` ``, `<(…)`, `>(…)` are checked the same way wherever the substitution stands: in double quotes, in `${x:-$(…)}`, inside `$((…))`, in a redirection target, in a heredoc body with an unquoted delimiter (`<<EOF`). The text of a heredoc body itself is not a command;
- text stays literal in single quotes, as `\$(…)` inside double quotes, and in heredoc bodies with a quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`);
- `$'…'` is decoded (`\n`, `\t`, `\'`, `\\` and so on), so `$'git' push` is `git push`; `\x`, `\u`, `\U`, octal codes and `\c` are not decoded, and the word counts as runtime-dependent. Inside ordinary double quotes `$'` is plain text;
- `\` followed by a newline is joined where bash joins it: `"$\⏎(…)"` is `$(…)`. In single quotes, comments and heredoc bodies with a quoted delimiter, lines are not joined;
- a `<<` heredoc terminator does not strip leading tabs — only `<<-` does; with several heredocs on one line the bodies are read in turn. Inside `$(…)` a body also ends on an `EOF)` line, as in bash; a line that only starts with the delimiter (`EOFx`), or a terminator that bash 3.2 and bash 5 read differently, gives `ask`;
- `case`/`esac` inside `$(…)` are keywords only in command position (`$(grep -c case f)` doesn't confuse the parser), and inside `case`, after `in` and `;;`, come patterns: `(esac)` or `case)` there is a pattern, not a keyword. Command position also includes the positions after `name()`, `function NAME`, `time -p`, `coproc`; inside `((…))` heredocs, quotes and comments are not looked for, but `$(…)` substitutions in it are checked;
- nesting of `bash -c`, `eval` and substitutions is checked three levels deep; deeper gives `ask`. An unterminated substitution also gives `ask`;
- input the parser can't follow (nesting deeper than about 32 levels of `$(` or 64 of `${`, or more than about 40 steps per character) gives `ask`;
- if the guard itself fails with an error, the answer is `ask` (see [Fail-open and fail-closed](#fail-open-and-fail-closed)).

The verdicts of all commands on the line are combined: `deny` beats `ask`, `ask` beats allow; the reasons of the winning level are joined. `git reset --hard && git push origin main` gets `deny`.

### Guard rules

| Command | Verdict | Details |
|---|---|---|
| `git push` to a branch from [`git.protected_branches`](#protected-branches) | deny | The target comes from the refspec: `main`, `HEAD:main`, `x:refs/heads/main`, `:main`, `--delete main`. `HEAD` and `@` mean the current branch. Without a refspec and without `--all` — the current branch. Forbidden with `--force-with-lease` too |
| `git push --force`, `-f` (also inside a flag cluster), `+refspec` | deny | Only `--force-with-lease` / `--force-if-includes` without `--force`, `-f` and `+refspec` is allowed, and only if the target isn't protected. `--force` cancels the lease check, so `--force --force-with-lease` is forbidden; `+refspec` is treated as `--force` (conservatively) |
| `git push --mirror` | deny | |
| `git push --no-verify` | deny | |
| `git commit --no-verify`, `-n` (also in a cluster: `-nm "…"`) | deny | In `git commit -m -n` the `-n` is the message text, which is allowed |
| `git push --all`, `--branches` | ask | Would push every local branch, protected ones included |
| `git reset --hard` | ask | |
| `rm -r`, `-R`, `--recursive` outside the project or on an unpredictable path | ask | See [Recursive rm](#recursive-rm) |
| `git push --dry-run`, `-n` | allowed | A dry run is not checked |

Order of the `git push` checks: `--mirror`, protected branch, force, `--no-verify`, `--all`; the first matching rule wins. git's global options before the subcommand (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`) are skipped.

A typical reason:

```
forge: push в защищённую ветку «main» запрещён (git.protected_branches). Работай в отдельной ветке и предложи пользователю PR или слияние.
```

("push to the protected branch «main» is forbidden (git.protected_branches). Work in a separate branch and offer the user a PR or a merge.")

### Abbreviated long options

git accepts any unambiguous prefix of a long option, so any prefix of a guarded option is read as that option: `--forc` and `--fo` are `--force`, `--no-verif` is `--no-verify`, `--mi` is `--mirror`, `--al` is `--all`, `--ha` is `--hard`. Guarded are `--force`, `--force-with-lease`, `--force-if-includes`, `--no-verify`, `--mirror`, `--all`, `--branches`, `--delete` for `push`, `--no-verify` for `commit`, `--hard` for `reset`. With an ambiguous prefix the first option of that list (the most dangerous one) wins. `--dry-run` must be spelled out in full: an abbreviation never turns a command into an allowed one.

### Recursive rm

A non-recursive `rm` is not checked. For every path of a recursive delete:

- the path depends on runtime (`$VAR`, `$(…)`, backticks) — `ask`;
- the path is cut at the first `*`, `?` or `[` and resolved from the current directory (`build/*` → `build/`);
- `/`, the home directory, the project root or one of its ancestors (`rm -rf .`, `rm -rf *` from the root) — `ask`;
- inside the project — allowed;
- inside the temp directories (`os.tmpdir()`, `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders`), but not the directory itself — allowed;
- anything else (`../other`, `~/x`, `/etc`) — `ask`.

### Protected branches

Without a profile: `main` and `master`. The profile field [`git.protected_branches`](#profile-fields) **replaces** this list; `[]` removes branch protection. Patterns are anchored at both ends of the name: `*` doesn't cross `/`, `**` does. `release/*` protects `release/1.2` but not `release/1.2/hotfix`.

[↑ Back to contents](#contents)

## File guard

A call to `Edit`, `Write`, `MultiEdit` or `NotebookEdit` for a path from `protected_files` is rejected (`deny`) with a reason. The path is taken relative to the project root; a file outside the project is matched by its absolute path, so `**/id_ed25519` also catches `~/.ssh/id_ed25519`.

The built-in list always applies; [`protected_files`](#profile-fields) from the profile is appended after it:

```
.env  .env.*  .envrc  !.env.example  !.env.sample  !.env.template
**/*.pem  **/*.key  **/id_rsa  **/id_ed25519
```

### Pattern syntax

As in `.gitignore`: a pattern without `/` matches at any depth; a pattern with `/` is anchored to the root (except those starting with `**/`); `*` and `?` don't cross `/`, `**` does; `{a,b}` is an alternative; a directory pattern covers everything inside it; the last match wins; `!pattern` removes protection, including a built-in one (`"!.env"`). [`docs.watch`](#what-counts-as-a-change) uses the same syntax.

[↑ Back to contents](#contents)

## Format and lint

`PostToolUse` appends every edited file to the [edit journal](#edit-journal) `.forge/edits.jsonl` — append only, so parallel hooks don't get in each other's way. `PostToolBatch` fires once after a batch of tool calls:

1. no profile, or neither [`commands.format`](#profile-fields) nor `commands.lint` — does nothing;
2. takes the files from the journal after the `lint_offset` cursor (unique, existing, inside the project) and moves the cursor;
3. runs `format`, then `lint`, until the first failure; the total budget is 150 s;
4. on failure returns `additionalContext`: the step, the command and up to 40 lines of output (head and tail). Claude gets it as context before its next step; the turn is not interrupted (`decision: "block"` on this event would stop the loop, and Claude would never see the reason).

`{files}` in a command is replaced with the shell-quoted list of files; `ext` keeps only files with those extensions; if no files are left, the step is skipped. A command without `{files}` runs as is, over the whole project, after every batch with edits. Commands run through `/bin/sh -c` in the project root with `CI=1`, `FORCE_COLOR=0`, `NO_COLOR=1`. Lint also works with [`verify.on_stop: "off"`](#verification-on-stop).

The context starts with «forge: после правок» ("after edits") and ends with «Исправь это до следующих шагов.» ("fix this before the next steps").

[↑ Back to contents](#contents)

## Verification on Stop

The `Stop` hook:

- does nothing without a profile, and while background subagents or workflows are still running — the check happens when they finish. With [`verify.on_stop: "off"`](#profile-fields) or empty `verify.steps` it skips only the check: the [reminders](#agent-docs-reminder) still work;
- if the edit journal grew since the last check, runs `verify.steps` in order until the first failure, within a total budget of `verify.timeout_sec`. With `on_stop: "fast"` the `test` step is replaced with `test_fast`, if it is set and has something to check. Steps with `{files}` get the files changed since the last check;
- records the result in [`.forge/state.json`](#state-file) (`verify`, `failures.verify_streak`): success resets the failure counter, a failure increments it. [`forge verify`](#commands) keeps the same counter;
- on success the turn ends silently; on failure it answers `decision: "block"`: Claude gets the step, the command, up to 60 lines of output and an instruction to fix it or tell the user honestly that the check fails.

The block reason starts with `forge: проверка перед завершением не прошла.` ("verification before finishing failed") and ends with «Исправь и заверши работу снова. Если исправить нельзя — честно сообщи пользователю, что проверка падает.» ("Fix it and finish again. If it can't be fixed, tell the user honestly that the check fails.").

### Failure streak

| Failures in a row | Behaviour |
|---|---|
| 1 | Doesn't let the turn end; shows Claude the output |
| 2 or more | The same, plus an instruction to hand the task to the [`debugger`](#roles) role (`forge route debugger`) together with the log |
| 3 or more, on a repeated stop (`stop_hook_active`) | Doesn't block: the user gets the message «проверка падает N раз(а) подряд, автопроверка отпустила сессию» ("the check has failed N times in a row, auto-verification released the session") |

If there are no new edits, but the last check failed and the user hasn't been told yet, the hook shows them a summary once: `forge: последняя проверка не прошла (…)` ("the last check failed"). So a stop without new edits after a failure doesn't loop.

[↑ Back to contents](#contents)

## Agent files

The agent files are `AGENTS.md` and `CLAUDE.md`. forge keeps a layout in which the text lives in one place and every tool reads it.

### Layout

- **`AGENTS.md` is the source.** The root `AGENTS.md` is the project map: what it is, directories, commands, rules, a table of areas with links to nested files. Codex, Cursor and other agents read it (see [agents.md](https://agents.md/)).
- **`CLAUDE.md` is the import.** Next to every `AGENTS.md` lies a `CLAUDE.md` consisting of one line, `@AGENTS.md` (after it you may add what only Claude Code needs). Claude Code reads `CLAUDE.md`, not `AGENTS.md` (see [memory](https://code.claude.com/docs/en/memory)), so without that line it never sees the text.
- **Nested files.** A large area (a monorepo package, a subsystem with its own commands and rules) gets its own `AGENTS.md` and the same `CLAUDE.md` shim. Claude Code loads a nested `CLAUDE.md` on demand, when it reads files in that directory — so the shim is needed in nested directories too: without it the area's rules are not picked up. The root `AGENTS.md` must mention the area's directory (`backend/`, `` `backend` ``), otherwise other agents won't know about it.

[`/forge:docs`](#skills) helps create, migrate and repair the files; [`forge docs`](#the-forge-docs-command) checks the structure; the [reminder at the end of a turn](#agent-docs-reminder) catches staleness.

### The forge docs command

`forge docs [--fix] [--json]` checks the structure of the agent files deterministically, without a model. It works without a profile too (with defaults). Directories with agent files are found like this: in a git repository with `git ls-files` (tracked and untracked, without ignored files), otherwise with a directory walk up to depth 6 and 20 000 entries. Skipped are hidden directories, `node_modules`, `vendor`, `dist`, `build`, `target`, `bin`, `obj`, `.venv`, `venv`, `__pycache__`, `Pods`, `DerivedData`; the walk doesn't follow symbolic links to directories but sees links to files. The `.forge/` directory is never scanned (it holds the `/forge:docs` backups). Whether a found directory has `AGENTS.md` and `CLAUDE.md` is decided on disk: a git-ignored file next to a found one counts too. A `CLAUDE.md` that is a symbolic link to the neighbouring `AGENTS.md` counts as a correct import, just like `@AGENTS.md`.

The output is lines `✗ <path>: <message> [<code>]` (error) and `! <path>: <message> [<code>]` (warning); with no issues — `✓ Агентские файлы в порядке` ("agent files are in order"). Exit code 1 if there is at least one error (`✗`); warnings (`!`) don't change it. An unknown argument gives exit code 2.

[`forge doctor`](#commands) adds a line: `✓ Агентские файлы в порядке`, or `✗`/`!` `Агентские файлы: N замечаний — forge docs` ("agent files: N issues — forge docs", with Russian plural agreement: 1 замечание, 2 замечания); `!` if all issues are warnings. The exit code of `doctor` doesn't change — it is always 0.

### Issue codes

| Code | Level | When | `--fix` |
|---|---|---|---|
| `missing-root` | error | No root `AGENTS.md` (if the root `CLAUDE.md` has content, the message asks to move it into `AGENTS.md`) | no, use `/forge:docs` |
| `missing-shim` | error | `AGENTS.md` exists, no `CLAUDE.md` next to it | yes: creates `CLAUDE.md` with `@AGENTS.md` |
| `no-import` | error | Both files exist, but `CLAUDE.md` has no `@AGENTS.md` line outside a code block (or `CLAUDE.md` can't be read) | yes, only if `CLAUDE.md` was read and is empty: replaces it with the import; with content — add the line yourself |
| `claude-only` | warning | A nested directory has a `CLAUDE.md` with content and no `AGENTS.md` | no |
| `fat-claude` | warning | `CLAUDE.md` has more than 30 non-empty lines, not counting `@AGENTS.md` | no |
| `too-long` | warning | The directory's agent file (`AGENTS.md`, otherwise `CLAUDE.md`) is longer than [`docs.max_lines`](#profile-fields) lines | no |
| `unlisted` | warning | A nested `AGENTS.md`, and the nearest agent file above doesn't mention its directory (`dir/` or `` `dir` ``) | no |
| `broken-link` | warning | A Markdown link `[…](path)` points to a path that doesn't exist. External URLs, `#anchors`, links in code blocks and in backticks are not checked; `/path` is relative to the root, others to the file's directory | no |
| `verify-undocumented` | warning | The command of a step from [`verify.steps`](#profile-fields) (its first one or two words: `npm test`, `pytest`; three for `npm`/`pnpm`/`yarn`/`bun run <script>`; leading assignments `FOO=1` and `cd <dir> &&` are skipped) appears in no agent file. Not checked when there are no agent files | no |
| `incomplete-scan` | warning | The directory walk (outside git) stopped at the entry limit: some files may not have been checked | no |

### Fixing and JSON output

`--fix` changes only `CLAUDE.md` files and only writes `@AGENTS.md` into a missing or empty file; it never touches existing text and doesn't treat a file it couldn't read as empty. It first prints `создан <path>` ("created") for each file and `пропущен <path>: <reason>` ("skipped") for each fixable issue it didn't fix (the file already exists, including a broken symbolic link; isn't empty; can't be read; couldn't be written), then re-runs the check and prints the usual report; the exit code follows that re-check.

`--json` prints the array of issues on one line (`[]` for a clean project):

```json
[{"code":"missing-shim","level":"error","path":"backend/CLAUDE.md","message":"…","fixable":true}]
```

`fixable: true` marks the issues that `--fix` repairs. With `--json` the «создан …» lines are not printed, and the «пропущен …» lines go to stderr.

Projects that already have `AGENTS.md` without `CLAUDE.md` in several directories are usually fixed by one `forge docs --fix`.

A nested git repository (not a submodule, but a separate `.git` in a subdirectory) is invisible to `forge docs` run from the parent repository: `git ls-files` shows only `sub/`, not the files inside. Run `forge docs` in the nested repository itself.

[↑ Back to contents](#contents)

## Agent docs reminder

After the check, `Stop` decides whether `AGENTS.md` and `CLAUDE.md` may be stale (the layout is in [Agent files](#agent-files)). The reminder is a `decision: "block"` with this reason:

```
forge: в этой задаче изменились команды или структура: … Проверь, не устарели ли … — команды, карта каталогов, правила. Если обновлять нечего — так и скажи и заверши работу.
```

("commands or structure changed in this task: … Check whether … are stale — commands, directory map, rules. If there is nothing to update, say so and finish.") The text is short (at most about 520 characters): the lists of changes and files are cut to «… и ещё N» ("… and N more"). It can be turned off with [`docs.remind: false`](#profile-fields).

### What counts as a change

The files from the [edit journal](#edit-journal) after the `docs.offset` cursor are taken. A change is one of two things:

- the file matches [`docs.watch`](#profile-fields) (by default `package.json`, `pyproject.toml`, `Cargo.toml`, `*.sln`, `Makefile`, `justfile`, `Taskfile.yml`, `docker-compose*.yml`, `compose*.yml`, `.github/workflows/**`, `.gitlab-ci.yml`; a pattern without `/` applies at any depth). A `package.json` in git counts only if its `scripts` differ from `HEAD` (key order doesn't matter; absent in `HEAD` or not readable as JSON — it counts), so a dependency edit stays quiet. Git is resolved for each `package.json` from its own directory (`git -C <dir>`): a project without git at the root with repositories in subfolders, and a nested repository or submodule inside a git project, are compared with their own `HEAD`. Outside git any edit of `package.json` counts; in a repository without commits every `package.json` is "new";
- in git: the file lies in a top-level directory that isn't in `HEAD`, and the root `AGENTS.md` doesn't mention it (`name/` or `` `name` ``). Hidden directories, files in the root, git-ignored files and a project without commits don't count; one directory is one change, shown in the text as «новый каталог name/» ("new directory name/"). Outside git there is no such signal.

### What clears a reminder

An edit, in the same window, of an `AGENTS.md` or a `CLAUDE.md` with content (not an `@AGENTS.md` import) in the directory of the changed file or in any of its ancestors; an edit of the root file clears everything. The reminder names the agent file nearest to the change (`AGENTS.md`, otherwise `CLAUDE.md`, otherwise the root `AGENTS.md`).

### Reminder memory

forge remembers in [`state.json`](#state-file) (`docs.reminded`) what it has already reminded about: a fingerprint of `scripts` for each `package.json`, and the names of new top-level directories. A signal that hasn't changed since its reminder (or was cleared by an agent file edit) doesn't remind again: after a reminder about `scripts`, a dependency-only edit stays quiet, and so do new files in an already named directory. Different `scripts` (a different fingerprint) or another new directory remind again. An entry is forgotten when the signal matches `HEAD`: `scripts` equal the committed ones again, the directory is committed or mentioned in the root `AGENTS.md`.

### Order and when it stays quiet

- After every stop the `docs.offset` cursor moves to the end of the journal, so the same edits are not examined twice. This is one window shared with the [reminder about an empty `[Unreleased]`](#reminder-about-an-empty-unreleased): both read the same files, and when both fire the reasons go into one block.
- [Verification](#verification-on-stop) comes first. If the check failed (`decision: "block"`), there is no reminder, the cursor stays, and the reminder comes after the next passing check. If the check released the session after three failures, there is no reminder either (the cursor stays). The one-off message «последняя проверка не прошла» ("the last check failed") may come together with a reminder in one answer.
- It stays quiet without a profile, while background subagents or workflows are running, if there is no `AGENTS.md` either in the root or in the directories above the changed files (checked before any git calls), and with `docs.remind: false`. When this reminder is off and the release reminder is off too (or there is no `release` section), `Stop` deletes `state.docs`, so that an old cursor doesn't hold back the journal reset; if only one of them is off, the shared cursor stays. `verify.on_stop: "off"` doesn't turn the reminder off.
- An error inside the reminder is logged and doesn't affect the check result: its `decision`/`systemMessage` is returned as usual.
- The first stop after updating forge (no cursor yet) only records the cursor: edits made before it are not reminded about.
- The cursor takes part in [resetting the edit journal](#edit-journal).

[↑ Back to contents](#contents)

## Releases and CHANGELOG

Opt-in. forge keeps a project's changelog and version in step with each other: it checks the file, works out the next version from the entries, and does the mechanical part of a release the same way every time. Judgement stays with the model and you: what to write in the changelog, whether a change breaks users, what to push and publish.

The scheme is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/):

- new entries go under `## [Unreleased]`, in the sections `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security` (any other `###` section is allowed too);
- a release moves them to `## [x.y.z] — YYYY-MM-DD`, writes the version into the [version files](#version-files), makes a commit `chore(release): x.y.z` and an annotated tag `<tag_prefix>x.y.z`, and fixes the comparison links at the bottom of the changelog;
- the current version is the highest `[x.y.z]` heading of the changelog (by SemVer, not by position); without one, the latest version tag with the prefix; without that, `0.0.0`.

Without a `release` section in the [profile](#profile-fields) nothing of this is active: no reminder, no doctor line, and `forge release` prints `✗ раздел release в профиле не настроен — forge init предложит его, если проект выпускается` ("the release section is not configured in the profile — forge init proposes it if the project is released") and exits with 1.

### Turning it on

Either [`forge init`](#stack-detection) proposes the section, or you add it by hand; the empty object turns it on with all defaults:

```json
"release": {}
```

Fields, defaults and the schema are in [Profile fields](#profile-fields). `forge init` proposes the section when it finds at least one signal at the project root; every signal is printed in the notes as `Релизы включены: …` ("releases enabled: …"):

- `CHANGELOG.md` exists;
- there are git tags that are versions: `x.y.z` or `vx.y.z`;
- CI that publishes or releases: `docker push`, `docker/build-push-action`, `npm publish`, `twine upload`, `cargo publish`, `dotnet nuget push`, `gh release`, `goreleaser`; CI that starts on tags (`push: tags` in GitHub Actions, `CI_COMMIT_TAG` in GitLab); a manual `workflow_dispatch` with an input named like `publish`, `deploy` or `release`. Looked at: `.github/workflows/*.yml` and `.gitlab-ci.yml`; comment lines are ignored.

The proposed `version_files` are the root files `package.json`, `.claude-plugin/plugin.json`, `pyproject.toml`, `Cargo.toml`, `pom.xml` and `*.csproj` whose version is found and isn't `0.0.0`, plus every root `README*.md` with a `version-x.y.z-` badge (as `{ "path": …, "pattern": … }`). `tag_prefix` is `""` if there are version tags and none starts with `v`, otherwise `v`. With no signal there is no `release` section. As always, `forge init` only shows the proposal; `--yes` writes it.

### The forge release command

`forge release` has three modes:

| Command | What it does |
|---|---|
| `forge release --check [--json]` | Checks the changelog and the version files ([codes](#changelog-checks)); changes nothing |
| `forge release [major\|minor\|patch\|x.y.z] [--date YYYY-MM-DD] [--json]` | Preview: the level and why, `current → next`, every file with its change, the tag and the commit message; changes nothing, needs neither a clean tree nor a git repository |
| `forge release <major\|minor\|patch\|x.y.z> --yes [--date YYYY-MM-DD] [--json]` | [Applies](#what-apply-does-and-refuses) the release; the level or version is required, so a release is always a conscious choice |

A preview of a project at 1.4.2 with `Added` and `Fixed` entries under `[Unreleased]`:

```
$ forge release
Уровень: minor (есть Added)
Версия: 1.4.2 → 1.5.0
Дата: 2026-11-21
Файлы:
  CHANGELOG.md: [Unreleased] → [1.5.0] — 2026-11-21
  package.json: 1.4.2 → 1.5.0
Тег: v1.5.0
Коммит: chore(release): 1.5.0

Выпустить: forge release minor --yes
```

("Level: minor (there is Added)", "Version", "Date", "Files", "Tag", "Commit", "Release: …".) The date is today in local time; `--date` sets another one (it ends up in the last line too). With `--json` the preview is one line `{level, reason, current, next, tag, files, commit}`, where `files` is `[{path, from, to}]`.

Exit codes: 0 — a preview, a done release, a clean `--check` (warnings `!` don't change it); 1 — `--check` found an error, the release section is missing, or the command refused (the reason is printed as `✗ …` on stdout); 2 — a usage error (an unknown argument, a bad level or date, `--yes` without a level, `--check` with a level, `--yes` or `--date`), printed to stderr.

### Choosing the level

With no level given, forge suggests one from `[Unreleased]`; only sections that have entries count:

| Level | When |
|---|---|
| `major` | there is a `### Removed` section, or an entry in a standard section says `BREAKING` (any case) or «несовместим» ("incompatible") |
| `minor` | there is `### Added` or `### Changed` |
| `patch` | anything else: only `Fixed`, `Deprecated`, `Security`, or only custom sections |

- **Custom sections never raise the level.** A section outside the six standard ones (for instance «Обновление», "Upgrade") counts as `patch` material, and `BREAKING` in its text is not looked at: the standard sections carry the level.
- **Before 1.0, `major` becomes `minor`:** while the current major is 0, a would-be `major` is suggested as `minor`, and the reason says so: `раздел Removed (до 1.0 major заменяется на minor)` ("before 1.0 major is replaced by minor"). Only the suggestion is softened; an explicit `major` is honoured.
- The suggestion is a default, not a verdict: whether a change breaks users is your judgement. Pass `major`, `minor` or `patch` to override, or an exact `x.y.z`. The new version must be greater than the current one. An explicit `major` from 0.x gives 1.0.0.
- Pre-release versions are read but not produced: a pre-release current version is understood (`1.0.0-rc.1` sorts below `1.0.0`), and a level drops the suffix (`patch` on it gives `1.0.1`). A level never produces a pre-release; an exact version is written as given, but forge has no pre-release workflow.

### What apply does and refuses

`forge release <level> --yes` checks first and changes nothing if any check fails; it prints `✗ …` and exits with 1. It refuses when:

- the directory is not a git repository, or tracked files have uncommitted changes (untracked files don't count);
- the changelog is missing or unreadable, has no `[Unreleased]`, or `[Unreleased]` has no entries ("nothing to release");
- a version file can't be read (see [Version files](#version-files));
- the new version is not greater than the current one, or the tag already exists.

If it isn't on the default branch it only warns (`! выпуск не с ветки main (сейчас …)`, "release not from branch main"). The default branch is `origin/HEAD`; where origin is unknown, no warning is made.

Then it, in order:

1. rewrites the changelog: `[Unreleased]` stays as an empty heading, its entries go under `## [x.y.z] — date`, the comparison links at the bottom get the new version (everything else in the file stays byte for byte, line endings and BOM included);
2. writes the new version into every version file, replacing only the version text;
3. `git add` of those files only, and `git commit` with the message `chore(release): x.y.z`;
4. creates the annotated tag `<tag_prefix>x.y.z` (message `release x.y.z`).

If any step fails, forge puts the files back byte for byte, undoes its own commit and leaves no tag, then prints `Файлы возвращены в исходное состояние, тег не создан.` ("the files are restored, no tag created"). On success it prints:

```
✓ Выпущена версия 1.5.0
Коммит: 3f9a1c2 chore(release): 1.5.0
Тег: v1.5.0
Отправить: git push origin main && git push origin v1.5.0
```

("Released version", "Commit", "Tag", "Push".) **forge never pushes**: the last line is a hint for you or for [`/forge:release`](#release-flow-in-claude), which asks first. The [Bash guard](#guard-rules) still applies to the push you run. With `--json` the result is `{level, reason, current, next, tag, files, commit, sha, branch}`.

### Version files

`release.version_files` lists the files that carry the version. For a path string forge picks the handler by the file name:

| File | Where the version is |
|---|---|
| `*.json` (`package.json`, `.claude-plugin/plugin.json`) | the top-level `"version"` string |
| `pyproject.toml` | `version` in `[project]`, otherwise in `[tool.poetry]` |
| `Cargo.toml` | `version` in `[package]` |
| `pom.xml` | the project's own `<version>`, a direct child of `<project>` (not the parent's or a dependency's) |
| `*.csproj` | `<Version>` |
| anything else, or any file as `{ "path": "…", "pattern": "…" }` | `pattern` is a regular expression with exactly one capture group; the group is the version. Every match is replaced |

For example, the version badge of a README: `{ "path": "README.md", "pattern": "version-(\\d+\\.\\d+\\.\\d+)-" }`. A write replaces only the version characters, so formatting, key order and the rest of the file stay as they were. A file of an unknown type without `pattern`, a missing file or a pattern that finds nothing is an error (`version-file-unreadable`). An invalid `version_files` item is [reported by `forge doctor`](#broken-profile) and ignored.

Every version file must hold the current version, otherwise [`forge release --check`](#changelog-checks) reports `version-mismatch`: a release on top of a mismatch would ship it under a new number. With no `version_files` the version lives only in the changelog and git tags.

### Changelog checks

`forge release --check` prints lines `✗ <path>: <message> [<code>]` (error) and `! <path>: <message> [<code>]` (warning), or `✓ Журнал изменений в порядке` ("the changelog is in order"); `--json` prints an array of `{code, level, path, message}` on one line (`level` is `error` or `warn`; `path` is absent for `tag-missing`). It works only with a `release` section. [`forge doctor`](#commands) adds a line: `✓ Журнал изменений в порядке`, or `✗`/`!` `Журнал изменений: N замечаний — forge release --check` ("changelog: N issues"; `!` if all are warnings); it doesn't change `doctor`'s exit code.

| Code | Level | When |
|---|---|---|
| `changelog-missing` | error | The file `release.changelog` doesn't exist or can't be read |
| `no-unreleased` | error | No `## [Unreleased]` heading: nowhere to add new entries |
| `duplicate-version` | error | One version appears twice |
| `version-order` | error | A version stands above a higher one: versions must descend from top to bottom |
| `version-file-unreadable` | error | A version file is missing or has no version where the handler looks |
| `version-mismatch` | error | A version file's version differs from the current one |
| `bad-heading` | warning | A `## ` line that is neither `[Unreleased]` nor `[x.y.z] — YYYY-MM-DD` |
| `bad-date` | warning | A release date is not `YYYY-MM-DD` |
| `link-mismatch` | warning | The comparison links at the bottom are missing or don't compare the neighbouring versions. Checked only if the file has any such links |
| `tag-missing` | warning | The latest version of the changelog has no git tag `<tag_prefix><version>` (in a git repository) |

### Reminder about an empty Unreleased

With a `release` section and `release.remind` not `false`, the `Stop` hook looks at the edits of the turn. If code changed (any edited file that is not the changelog itself and doesn't match [`release.ignore`](#profile-fields), which by default covers tests, `docs/**` and Markdown) and `[Unreleased]` has no entries, the turn is blocked once with this reason:

```
forge: в этой задаче менялся код (…), а в CHANGELOG.md в [Unreleased] пусто. Если изменение заметно тому, кто пользуется проектом, добавь запись в нужный раздел; если нет — так и скажи и заверши работу.
```

("code changed in this task (…), and [Unreleased] in CHANGELOG.md is empty. If the change is noticeable to someone who uses the project, add an entry in the right section; if not, say so and finish.") The list of files is cut to about 100 characters with «… и ещё N» ("… and N more"). Adding any entry to `[Unreleased]` clears it: the reminder only looks at whether the section is empty.

- **One window.** The reminder reads the same window of edits as the [agent docs reminder](#agent-docs-reminder): the journal after the `docs.offset` cursor, which is the one cursor of both. After every stop it moves to the end. If both reminders fire, Claude gets one `block` with both reasons, separated by a blank line; each part's error is logged and doesn't cost the other.
- **Once per branch.** What was already reminded about is kept in [`state.json`](#state-file) (`release.reminded`, the newest 20 keys). On a feature branch the key is the branch name: one reminder per branch. On the default branch (`origin/HEAD`, or `main`/`master` where origin is unknown) and on a detached `HEAD` the key is `<branch>@<latest version tag>` (`@none` with no tags): one reminder per released version, so it comes back after the next release.
- **Order.** [Verification](#verification-on-stop) comes first: a failed check (`block`) or a released session (three failures) means no reminder, and the cursor stays for the next passing check. Like the other reminder, it stays quiet without a profile and while background subagents run, and the first stop after an update only records the cursor.
- **When it stays quiet.** There is no `release` section, `release.remind` is `false`, the changelog file is missing (`forge release --check` reports that), `[Unreleased]` already has entries, only ignored files changed, or this branch was already reminded.

### Release flow in Claude

[`/forge:release`](#skills) runs the release with the user. Mechanics (checks, level, files, commit, tag) belong to `forge release`; the skill adds judgement and keeps every step that leaves the machine behind your yes:

1. `forge release --check`. On `✗` it stops and the problem is fixed first.
2. Reads `[Unreleased]` as a user of the project would: entries should say what a user notices, each sits in the right section; compares with `git log <last tag>..HEAD`. Wording changes are proposed as a list and applied only with your OK: the text becomes permanent once tagged.
3. `forge release --json`: shows the suggested level, the reason and `current → next`; you can override the level or give `x.y.z`.
4. On your OK, `forge release <level> --yes`. A refusal is reported as printed, not worked around.
5. Asks before pushing; pushes the branch and the tag with the command that `forge release` printed, never with force. A refused push (a protected branch) is reported, not bypassed.
6. Looks in `AGENTS.md` and the docs for what the project does after a tag (a GitHub release with the changelog section as notes, publishing images or packages, deployment, updating config in another repository) and offers these steps one by one, each with its exact command and **only with your explicit approval**. It never invents a step that isn't documented; if nothing is documented, it offers only `gh release create <tag> --verify-tag --notes-file …`, and only if `gh` is installed and `origin` is on GitHub.

[`/forge:review`](#skills) tells the reviewer when the project has a `release` section, so a user-visible change in the diff without an `[Unreleased]` entry is a finding. [`/forge:init`](#skills) mentions a proposed `release` section in its summary and offers to create a `CHANGELOG.md` with an `## [Unreleased]` heading if there is none.

[↑ Back to contents](#contents)

## Session start context

On `startup`, `resume`, `clear`, `compact`:

- no profile and not a git repository — nothing, not even the Superpowers warning (the hook exits right away);
- a git repository without a profile — one line suggesting `/forge:init`;
- with a profile — a line with the mode (from the state, otherwise from the profile), tier, verification steps, `on_stop` and a reminder about `forge route <role>`; when needed, lines about the active task (slug, stage, path to the plan), a failed last check, the number of [profile errors](#broken-profile) and ignored [`routing` overrides](#routing-overrides);
- with a profile and no root `AGENTS.md` — the line `forge: нет AGENTS.md — /forge:docs поможет завести.` ("no AGENTS.md — /forge:docs will help set one up"); if there is a `CLAUDE.md` that doesn't import `AGENTS.md` (no `@AGENTS.md` line outside a code block) — `forge: CLAUDE.md не подключает AGENTS.md — forge docs.` ("CLAUDE.md doesn't import AGENTS.md — forge docs"). Only these two files are checked, without walking directories; a `CLAUDE.md` that is a symbolic link to `AGENTS.md` counts as an import; with a correct pair there is no line;
- the [Superpowers warning](#superpowers-conflict), if it is enabled — in a git repository, with or without a profile.

The whole text is cut to 600 characters.

[↑ Back to contents](#contents)

## Profile

The project profile is `.forge/profile.json`. [`forge init`](#stack-detection) writes it together with a copy of the schema.

### Example

```json
{
  "$schema": "./profile.schema.json",
  "version": 1,
  "commands": {
    "format": "npx prettier --write --ignore-unknown {files}",
    "lint": { "run": "npx eslint {files}", "ext": [".ts", ".tsx"] },
    "typecheck": "npx tsc --noEmit",
    "test": "npm test",
    "test_fast": { "run": "npx vitest related --run {files}", "ext": [".ts", ".tsx"] }
  },
  "verify": { "steps": ["typecheck", "lint", "test"], "on_stop": "fast", "timeout_sec": 300 },
  "git": { "protected_branches": ["main", "master", "release/*"] },
  "protected_files": ["secrets/**", "!config/dev.key"],
  "risky_paths": ["**/migrations/**", ".github/workflows/**"],
  "docs": { "remind": true, "max_lines": 200 },
  "release": { "tag_prefix": "v", "version_files": ["package.json"] },
  "tdd": "encouraged",
  "mode": "normal",
  "routing": { "normal": { "implementer": "opus/medium" } }
}
```

### Profile fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `$schema` | string | — | `forge init` writes `./profile.schema.json` |
| `version` | `1` | — | Format version |
| `commands` | object: name → string or `{ "run": string, "ext": [".ext"] }` | `{}` | Shell commands. `format` and `lint` run in [`PostToolBatch`](#format-and-lint); `test_fast` replaces `test` in a fast check; any name can be used in `verify.steps` |
| `verify.steps` | string[] | `[]` | Names from `commands`, in order ([Verification on Stop](#verification-on-stop)). An empty list means no auto-verification. A step missing from `commands` is dropped with an error |
| `verify.on_stop` | `off` \| `fast` \| `full` | `fast` | `off` — Stop doesn't verify; `fast` — `test_fast` instead of `test`; `full` — steps as they are |
| `verify.timeout_sec` | integer 1–540 | `300` | Total budget of one check across all steps |
| `git.protected_branches` | string[] | `["main", "master"]` | [Branches](#protected-branches) you can't push to. **Replaces** the built-in list rather than extending it; `[]` removes branch protection |
| `protected_files` | string[] | `[]` | **Appended** to the [built-in list](#file-guard); `!pattern` removes protection |
| `risky_paths` | string[] | `[]` | Hooks don't apply it. Read by [`forge:plan`](#skills): work here is tier 3 and the `senior` role |
| `tdd` | `off` \| `encouraged` \| `required` | `encouraged` | Used by [skills](#skills): with `required`, `forge:plan` puts test tasks before implementation, and `forge:execute` passes the setting to the implementer. Hooks don't apply it |
| `docs.remind` | boolean | `true` | `false` turns off the [reminder about agent files](#agent-docs-reminder) at the end of a turn; [`forge docs`](#the-forge-docs-command) always works |
| `docs.max_lines` | integer > 0 | `200` | An agent file longer than this gets the [`too-long`](#issue-codes) warning |
| `docs.watch` | string[] | built-in list | **Appended** to the built-in list (see [What counts as a change](#what-counts-as-a-change)); [syntax](#pattern-syntax) as for `protected_files`, `!pattern` removes an entry, a built-in one included (`"!Makefile"`) |
| `release` | object | absent | Turns on [releases and the changelog](#releases-and-changelog). Without it none of that is active; `{}` turns it on with the defaults below |
| `release.changelog` | string | `CHANGELOG.md` | Path to the changelog from the project root. The format is Keep a Changelog |
| `release.tag_prefix` | string | `v` | Prefix of the git tag of a version (`v1.2.3`); `""` gives `1.2.3` |
| `release.version_files` | (string \| `{ "path", "pattern" }`)[] | `[]` | Files that hold the version, kept in sync by `forge release`: a path (the handler is picked by the file name) or a path with a `pattern` with one capture group. See [Version files](#version-files). Empty means the version lives in the changelog and tags only |
| `release.remind` | boolean | `true` | `false` turns off the [reminder about an empty `[Unreleased]`](#reminder-about-an-empty-unreleased); `forge release` always works |
| `release.ignore` | string[] | built-in list | **Appended** to the built-in list of files whose edits need no changelog entry: `test/**`, `tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `docs/**`, `*.md`, `**/*.md`, `.forge/**`; [syntax](#pattern-syntax) as for `protected_files`, `!pattern` removes an entry, a built-in one included (`"!docs/**"`) |
| `mode` | `eco` \| `normal` \| `max` | `normal` | Default [mode](#models-by-mode); the mode set by `forge mode` is stored in the state and wins over the profile |
| `routing` | `{ mode: { role: "model/effort" } }` | `{}` | Overrides of the model table, see [Routing overrides](#routing-overrides) |

### Broken profile

A broken profile doesn't block work. The profile is laid over the defaults. Invalid JSON — all defaults apply; an invalid field — the default for that field, the rest is applied. The errors are shown by [`forge doctor`](#commands) and (as a count) by [session start](#session-start-context).

### Stack detection

`forge init` picks the first stack found in the order below; the others go to the notes. `verify.steps` are those of `typecheck`, `lint`, `test` that were found. Branches are `main`, `master` and `origin`'s default branch; `risky_paths` are `**/migrations/**`, `.github/workflows/**`. Separately from the stack, `forge init` proposes a [`release` section](#turning-it-on) if the project looks like one that cuts releases.

| Stack | Signals | Commands |
|---|---|---|
| Node/TS | `package.json`; npm, pnpm, yarn or bun by lock file | `format`: prettier or biome; `lint`: eslint on files or the `lint` script; `typecheck`: the `typecheck`/`type-check` script or `tsc --noEmit` with `tsconfig.json`; `test`: the `test` script; `test_fast`: `vitest related` or `jest --findRelatedTests` |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`; prefix `uv run` or `poetry run` by lock file | ruff format and check, mypy or pyright, `pytest -q` |
| Swift | `Package.swift`, `*.xcodeproj`, `*.xcworkspace` | swiftformat and swiftlint when their configs exist, `swift test` for SwiftPM; `on_stop: "off"` — tests are slow |
| Go | `go.mod` | `gofmt -w {files}`, `go vet ./...`, `go test ./...` |
| Rust | `Cargo.toml` | `rustfmt {files}`, `cargo clippy`, `cargo test` |

[↑ Back to contents](#contents)

## Model routing

Each role gets a model and effort from the current mode's table. forge doesn't touch the main session: its model is the user's choice. Roles are dispatched by the skills [`/forge:plan`, `/forge:execute`, `/forge:review` and `/forge:docs`](#skills); the agents themselves are Claude Code [subagents](https://code.claude.com/docs/en/sub-agents).

### Roles

| Role | Who runs it | What for |
|---|---|---|
| `scout` | `forge:scout` (Read, Grep, Glob) | Find and read code, return a summary with `path:line` |
| `mechanic` | `forge:implementer` | An edit from precise instructions |
| `implementer` | `forge:implementer` (Read, Grep, Glob, Edit, Write, Bash) | A plan task |
| `senior` | `forge:implementer` | A task that can't be fully specified or where a mistake is expensive; the first retry after an implementer failure |
| `architect` | the main session (`agent=main`) | Spec and plan; the table row is for reference |
| `reviewer` | `forge:reviewer` (Read, Grep, Glob, Bash) | Diff review |
| `debugger` | `forge:debugger` (all tools) | Escalation after repeated failures |

### Models by mode

| Role | eco | normal | max |
|---|---|---|---|
| scout | haiku / low | haiku / low | sonnet / medium |
| mechanic | sonnet / low | sonnet / medium | sonnet / high |
| implementer | sonnet / medium | sonnet / high | opus / high |
| senior | sonnet / high | opus / high | opus / xhigh |
| architect | sonnet / high | opus / high | opus / xhigh |
| reviewer | sonnet / high | opus / high | fable / high |
| debugger | opus / high | fable / high | fable / high |

Strength is compared by model first (`haiku` < `sonnet` < `opus` < `fable`), then by effort (`low` < `medium` < `high` < `xhigh` < `max`). Switch the mode with [`/forge:mode`](#skills) or [`forge mode`](#commands); the default comes from the profile field [`mode`](#profile-fields).

### How skills dispatch a role

A skill runs [`forge route <role>`](#commands) and gets `role=… mode=… agent=… model=… effort=…`, then calls the agent from `agent=` with that `model` and `effort`; with `agent=main` the session does the work itself. That is why `/forge:mode eco` changes the models of the next calls without editing agent files. `model` and `effort` in the agents' frontmatter equal the `normal` row and are only a fallback for when an agent is called without them. `mechanic` and `senior` have no file of their own: without `forge route` they get the implementer values — `sonnet/high`, so senior would end up weaker than the table says.

### Retry ladder

Used by [`forge:execute`](#skills):

| Failed role | First retry, with the failure log | Second failure |
|---|---|---|
| `mechanic` | `implementer` | `debugger` with both logs |
| `implementer` | `senior` | `debugger` |
| `senior` | `senior` | `debugger` |
| any other (for example, `scout`) | the same role | `debugger` |

If `debugger` doesn't manage either, the skill stops and tells the user what is blocked. Separately, the Stop hook suggests `debugger` on the [second verification failure in a row](#failure-streak).

### Invariants

`checkTable` in `lib/route.mjs`, for every mode:

- every role has a `model/effort` value with a known model and effort; there are no unknown roles;
- reviewer is not weaker than implementer; senior is not weaker than implementer; reviewer is not weaker than senior; debugger is not weaker than senior;
- `eco` has no `fable`.

The tests additionally require that in the built-in table senior is strictly stronger than implementer, the agents' frontmatter matches the `normal` row, scout has no Edit, Write and Bash, and reviewer has no Edit and Write.

### Routing overrides

The profile's [`routing`](#profile-fields) is laid over the built-in table by mode and role, and the result is checked by the same invariants. Any error — and the whole `routing` block is ignored in every mode, and the built-in table applies. This is reported by [session start](#session-start-context) (as a count), `forge doctor` (lines `✗ routing: …`), `forge mode` (the line `! переопределения routing …` on stdout, "routing overrides … ignored") and `forge route` (on stderr). An override may make senior equal to implementer — then the first retry simply repeats the same model.

[↑ Back to contents](#contents)

## Skills

Skills are Claude Code [skills](https://code.claude.com/docs/en/skills) shipped with the plugin; heavy work goes to roles through [`forge route`](#how-skills-dispatch-a-role).

| Skill | Invoked by | What it does | Artifacts and state |
|---|---|---|---|
| `/forge:init` | the user only | [Detects the stack](#stack-detection), agrees on and writes the profile, runs `forge doctor`, then `forge docs`: on `missing-root` offers `/forge:docs`, on `missing-shim` — `forge docs --fix`. If `forge init` proposed a [`release` section](#turning-it-on), says why and offers to create a missing `CHANGELOG.md` | `.forge/profile.json`, `.forge/profile.schema.json`, `.git/info/exclude` |
| `/forge:mode [eco\|normal\|max]` | the user only | Shows or switches the [mode and its table](#models-by-mode) | `mode` in `.forge/state.json` |
| `/forge:plan` | the model (a feature or a change across several files) or the user | Context through `scout`, up to three questions, a spec of up to ~40 lines, a task plan with [roles](#roles), checks and groups for parallel runs; waits for a yes | `.forge/work/<slug>/spec.md`, `plan.md`; `task.slug`, `stage: plan`, `tier` 2 (3 if [`risky_paths`](#profile-fields) are touched), `artifacts.spec`, `artifacts.plan` |
| `/forge:execute` | the model or the user | Ready tasks go to roles through `forge route`, tasks with disjoint files in parallel; a task is ticked only after its `check` passed (if the report doesn't show it, the skill runs it itself); the [retry ladder](#retry-ladder); at the end `forge verify` and `forge:review` (always at tier 3, at tier 2 unless the user declined) | `[x]` marks in `plan.md`; `stage: execute`, then `review` |
| `/forge:docs` | the model or the user | Creates, migrates and splits [agent files](#agent-files) by the "AGENTS.md is the source, CLAUDE.md imports it" layout (create, move from the root `CLAUDE.md` or other tools' rule files, split long ones, fix links). Starts with `forge docs --json`, reads the files itself, explores areas through `scout`; shows a draft and writes nothing without a yes. Before editing, copies the affected files to `.forge/work/docs-backup/<time>/` (in git, when `.forge/work/` isn't ignored, to `<git-common-dir>/forge-docs-backup/<time>/`), moves text verbatim and checks that no line was lost | `AGENTS.md`/`CLAUDE.md` files, a backup; doesn't change the state |
| `/forge:review` | the model or the user | The base is `git merge-base` with a protected branch; reviewer through `forge route` (a diff over ~800 lines — several in parallel, by area); re-checks blocker and major findings; shows findings by severity and asks what to fix. With a `release` section the reviewer also flags a user-visible change with no `[Unreleased]` entry | `.forge/work/<slug>/review.md` (without an active task — `.forge/work/review.md`); `stage: review` |
| `/forge:release` | the model (when you ask to release) or the user | Releases a project with a `release` section: `forge release --check`, a read of `[Unreleased]` with proposed wording fixes, the level with you, `forge release <level> --yes`, then a push only after you agree; steps specific to the project (a GitHub release, publishing, deployment) only if documented and only with your explicit approval. See [Release flow in Claude](#release-flow-in-claude) | the changelog, version files, a commit and a tag; doesn't change the state |

### Plan task format

```markdown
- [ ] T1 <imperative title>
  role: implementer
  files: src/a.ts, src/a.spec.ts
  check: npm test -- a.spec
  depends: -
```

`role` is `implementer`, `mechanic`, `senior` or `scout`; `senior` is at most a third of the plan's tasks. Agents don't commit, push or switch branches — git stays with the main session.

[↑ Back to contents](#contents)

## forge CLI

### Commands

| Command | What it does | Exit code |
|---|---|---|
| `forge init` | Shows the [stack](#stack-detection), the proposed profile and notes; writes nothing | 0 |
| `forge init --yes [--force]` | Writes the profile and a copy of the schema, adds the [excludes](#what-init-writes) to `.git/info/exclude`; overwrites an existing profile only with `--force` | 0; 1 — the profile already exists |
| `forge state [get [key]]` | The whole [state](#state-file) or a field by dotted path (`task.slug`) | 0 |
| `forge state set <key> <value> […]` | Changes fields in pairs; a value is read as JSON, otherwise as a string. Checked: `tier` (integer 0–3), `stage` (`spec`, `plan`, `execute`, `review`, `finish` or `null`), `mode` | 0; 2 — error |
| `forge state reset` | Resets `tier` (to 1), `stage`, `task`, `artifacts`, `failures`; the mode, the check result and the cursors stay | 0 |
| `forge mode [eco\|normal\|max]` | Shows or switches the [mode](#models-by-mode) (in the state) and prints its table | 0; 2 — unknown mode |
| `forge route <role> [--json]` | `role=… mode=… agent=… model=… effort=…` or the same as JSON ([how skills use it](#how-skills-dispatch-a-role)) | 0; 2 — no role given or unknown role |
| `forge route --table` | The current mode's table | 0 |
| `forge verify [--fast] [--json]` | Runs [`verify.steps`](#verification-on-stop), records the result and the failure counter; `--json` prints `{ok, summary, failed, streak}` | 0 — passed; 1 — failed, no profile or no steps |
| `forge docs [--fix] [--json]` | Checks `AGENTS.md`/`CLAUDE.md` ([codes and levels](#issue-codes)); `--fix` creates missing and empty `CLAUDE.md` files with the `@AGENTS.md` line; `--json` prints an array of `{code, level, path, message, fixable}` | 0 — no errors (warnings allowed); 1 — there is an error; 2 — unknown argument |
| `forge release --check [--json]` | Checks the changelog and the version files ([codes](#changelog-checks)); `--json` prints an array of `{code, level, path, message}` | 0 — no errors (warnings allowed); 1 — there is an error, or no `release` section; 2 — usage error |
| `forge release [major\|minor\|patch\|x.y.z] [--date YYYY-MM-DD] [--json]` | [Preview](#the-forge-release-command) of a release: level and reason, `current → next`, files, tag, commit; changes nothing | 0; 1 — nothing to release or another refusal, or no `release` section; 2 — usage error |
| `forge release <major\|minor\|patch\|x.y.z> --yes [--date YYYY-MM-DD] [--json]` | [Cuts the release](#what-apply-does-and-refuses): changelog, version files, commit `chore(release): x.y.z`, annotated tag; rolls back on failure; never pushes | 0; 1 — refused or failed (the files are restored); 2 — usage error, or no level given |
| `forge doctor` | Node, plugin and project paths, [profile validity](#broken-profile), executables of the verification commands, git excludes, the [routing table](#routing-overrides), [agent files](#the-forge-docs-command), the [changelog](#changelog-checks) (with a `release` section), [Superpowers](#superpowers-conflict), recent [hook errors](#fail-open-and-fail-closed) | always 0 |
| `forge help`, `-h`, `--help`, no arguments | Help | 0 |

An unknown command (or `state` subcommand) gives exit code 2, an internal CLI error gives 3. Errors are printed to stderr as `forge: …`.

### Project root

The project root for the CLI and the hooks is `CLAUDE_PROJECT_DIR` if it is set; otherwise the nearest ancestor of the current directory with `.forge/profile.json` (not above the home directory); otherwise the root of the git repository; otherwise the current directory.

[↑ Back to contents](#contents)

## Files and state

### The .forge directory

```
.forge/
├── profile.json          profile (commit it if you like)
├── profile.schema.json   copy of config/profile.schema.json
├── state.json            session state                           ┐
├── edits.jsonl           edit journal                            │ in .git/info/exclude
├── work/<slug>/          spec.md, plan.md, review.md             │
└── log/errors.log        internal hook errors                    ┘
```

### State file

`state.json`: `tier` (0–3, default 1), `stage`, `mode` (`null` — from the profile), `task.slug`, `artifacts.spec` and `artifacts.plan`, `verify` (`at`, `ok`, `summary`, `failed_step`, `edits_offset`, `notified`), `failures.verify_streak`, `lint_offset`, `docs.offset` (the cursor shared by both [Stop reminders](#reminder-about-an-empty-unreleased)), `docs.reminded` ([reminder memory](#reminder-memory)) and `release.reminded` (the keys of the [release reminder](#reminder-about-an-empty-unreleased): a list of at most 20 strings). It changes only through [`forge state`](#commands) and the hooks; a corrupted file is replaced with defaults. `forge state set`, `forge state reset` and `forge mode <mode>` create it even without a profile.

### Edit journal

`edits.jsonl`: one line `{"t": <ms>, "f": "<path from the root>"}` per edit. [Lint](#format-and-lint), [verification](#verification-on-stop) and the [Stop reminders](#agent-docs-reminder) keep their own byte cursors (`lint_offset`, `verify.edits_offset`, `docs.offset`; the agent docs and release reminders share the last one). When all active cursors have reached the end and the journal is at least 256 KB, it is truncated and the cursors are reset to 0. The `docs.offset` cursor may be absent (the first stop after an update; when both reminders are off `Stop` deletes `state.docs`) — then it doesn't hold back the reset; while it exists and lags behind, the journal is kept.

There is one state per working directory. Run parallel sessions in separate worktrees.

[↑ Back to contents](#contents)

## Development

### Repository layout

```
.claude-plugin/     plugin.json (manifest, version), marketplace.json (the forge-dev marketplace)
hooks/              hooks.json and thin wrappers over lib/: JSON on stdin → JSON on stdout
lib/                all the logic: guards, shell, glob, profile, state, edits, verify, docs, changelog, release, route, detect, cli, git, paths, settings, util
config/             routing.json (roles and the mode table), profile.schema.json
agents/             scout, implementer, reviewer, debugger
skills/             init, mode, plan, execute, review, docs, release
bin/forge           CLI entry point
test/               node:test; helpers.mjs — temporary repositories, running hooks and the CLI
docs/               spec.md — specification and design decisions
.github/workflows/  test.yml: npm test on Node 20, 22, 24
```

The plugin layout follows the Claude Code [plugins reference](https://code.claude.com/docs/en/plugins-reference).

### Running tests

```bash
npm test                              # node --test test/*.test.mjs (unquoted: the shell expands the glob, Node 20 can't)
node --test test/guards.test.mjs      # one file
```

### Testing hooks

`runHookScript(name, input, { projectDir })` from `test/helpers.mjs` runs `node hooks/<name>.mjs`, feeds the event JSON on stdin, sets `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and an isolated `CLAUDE_CONFIG_DIR` (the developer's settings are not read) and returns the exit code, stdout and the parsed JSON. Fixture projects: `gitRepo(branch)` (a temporary repository without commit signing and git hooks), `writeProfile`, `write`; the CLI: `runCli(args, { cwd })`.

### Adding a guard rule

1. Logic goes to `lib/guards.mjs` (`checkPush`, `checkCommit`, `checkGit`, `checkRm`, or a new branch by command name in `checkBash`); the verdict is `deny(…)` or `ask(…)` with a reason in Russian starting with `forge:`. Command parsing lives in `lib/shell.mjs`.
2. Tests go to `test/guards.test.mjs`: the forbidden spellings and similar allowed ones; parsing changes also go to `test/glob-shell.test.mjs`.
3. Update the [rules table](#guard-rules) in this README (and in [README.ru.md](README.ru.md)) and add an entry to `CHANGELOG.md`.

### Adding a role

1. `config/routing.json`: `roles.<role>.agent` (an existing agent, or `null` for the main session) and the role's row in each of `eco`, `normal`, `max`.
2. `config/profile.schema.json`: the role in `$defs.routingMode.properties` — it has `additionalProperties: false`, so without this an override fails the schema.
3. If the role is on the [ladder](#retry-ladder) — [invariants](#invariants) in `checkTable` (`lib/route.mjs`) and tests in `test/route-profile.test.mjs`: the built-in table passes them, violating overrides are rejected.
4. A new agent — `agents/<name>.md` with `model`/`effort` equal to the `normal` row, and its name in the frontmatter test list in `test/route-profile.test.mjs`.
5. The skills that call the role; the READMEs and `CHANGELOG.md`.

Rules for anyone changing forge (agents included) are in [AGENTS.md](AGENTS.md).

[↑ Back to contents](#contents)

## Limitations

### Guards

- **The guards are a safety net against mistakes, not a sandbox.** They are not designed for a command that is deliberately hidden. [Not checked](#how-a-command-is-read):
  - a script fed to a shell through stdin: `… | bash`, `bash <<EOF`, `bash <<<'…'`, `bash -s`;
  - a command after a wrapper with a separate flag value or a wrapper not on the list: `sudo -u user …`, `nice -n 5 …`, `timeout 5 …`, `xargs …`, `coproc …`;
  - a target known only at runtime: `cd "$dir"`, `eval "$cmd"`, `bash -c "$script"`, `git push origin "$branch"`, a refspec with an undecodable `$'\x…'`;
  - a command whose name comes from a substitution: `$(true) git push --force origin main`, `${x:-}git push …`, `` `…`git push … ``, `$UNSET git push …`, `${x:-git push --force origin main}`. bash will run such commands, the guard lets them through. This is accepted for now: the guard protects against mistakes, not against evasion;
  - `source`/`.`, shell aliases and functions, `find -exec`, git aliases (`git -c alias.x='!…'`), scripts written to a file and run (`./deploy.sh`, `npm run …`), other interpreters (`python -c`, `node -e`), `ssh`;
  - input the parser can't follow (nesting deeper than about 32 levels of `$(` or 64 of `${`, or more than about 40 steps per character): it isn't checked in full, the command gets `ask`.
- `git push` without a refspec is checked against the name of the current local branch. If the upstream points to a branch with a different name or `remote.<name>.push` defines its own refspecs, the guard doesn't see it ([Guard rules](#guard-rules)).
- `--no-verify` is caught only for `git commit` and `git push`. `git -c core.hooksPath=… commit`, `git merge --no-verify` and environment variables that disable hooks are not caught.
- Other destructive commands are not guarded: `git clean`, `git checkout -- .`, `git restore`, `git branch -D`, `find -delete`, non-recursive `rm`.
- The [file guard](#file-guard) fires only on edit tools. Reading `.env` is not blocked; writing through Bash (`echo … > .env`, `sed -i`) is not caught.

### Edits outside edit tools

- The [edit journal](#edit-journal) is written only by edit tools. Changes made only through Bash (code generation, `sed -i`, `git apply`) trigger neither [lint](#format-and-lint) nor [verification at the end of a turn](#verification-on-stop).
- The [reminder](#agent-docs-reminder) also sees only edits made with edit tools: a command changed through Bash won't trigger it.

### Reminder and forge docs

- Reminder signals are computed against the `HEAD` of their own repository, and repeats are suppressed by the [reminder memory](#reminder-memory) (`docs.reminded`): the same `scripts` fingerprint and the same new directory don't remind twice. The memory sees only `scripts` and directory names: other files from `docs.watch` (workflows, `Makefile`) remind on every edit in a new window, unless an agent file is edited in the same window.
- Without git the signals are coarser: the first edit of `package.json` counts as a change of commands even if only dependencies changed (after that, only a change of `scripts`); there is no new-directory signal. In a repository without commits every `package.json` counts as new (the first edit reminds), and there is no new-directory signal either.
- `docs.watch` doesn't look at file contents, except `scripts` in `package.json`.
- [`forge docs`](#the-forge-docs-command) checks structure, not meaning: it doesn't find stale commands and paths in the text (except `broken-link` and `verify-undocumented`). That is the job of `/forge:docs`. `--fix` repairs `fixable` issues only for `CLAUDE.md`.

### Releases

- **Keep a Changelog only.** Parsing, checks and editing understand `## [Unreleased]` and `## [x.y.z] — date` with `###` sections, and nothing else; another changelog format is reported by `forge release --check` (`bad-heading`, `no-unreleased`) and can't be released.
- **One changelog and one version per project root.** There is a single `release.changelog` and a single current version; a monorepo with separate versions per package is not supported.
- **Pre-release versions are read, not produced.** `1.0.0-rc.1` in the changelog, a tag or a version file is understood and sorts below `1.0.0`, but a level (`major`, `minor`, `patch`) always gives a plain `x.y.z`; there are no `rc` or build-metadata workflows.
- **The default branch** comes from `origin/HEAD`; where origin or its `HEAD` is unknown, `main` and `master` are taken for the reminder's tag-keyed memory, and the release-from-another-branch warning is not made.
- The release reminder, like the agent docs one, sees only [edits made with edit tools](#edits-outside-edit-tools) and doesn't judge what counts as user-visible beyond `release.ignore`: that is for Claude and for [`/forge:release`](#release-flow-in-claude).
- `forge release --yes` commits only the changelog and the version files and stops before the push; publishing and deployment are done by CI or by steps you approve.

### Other

- `risky_paths`, task tiers and `tdd` are hints for the skills in 0.3.0; the hooks don't apply them. That a skill calls a role through `forge route` with the right `model` and `effort` is ensured by the model, not by mechanics ([How skills dispatch a role](#how-skills-dispatch-a-role)).
- The [edit journal](#edit-journal) is reset only when all active cursors have caught up (`verify.edits_offset`, `lint_offset`, `docs.offset` if present; the last one is shared by both Stop reminders). The cursor of a consumer that doesn't run (no `format`/`lint` commands, `verify.on_stop: "off"`) stays at 0 and prevents the reset — this was the case before `forge docs` as well.
- One session per working directory: two sessions in one checkout share `.forge/state.json` and the edit journal.
- Superpowers is recognised only by `enabledPlugins` in the [three settings files](#superpowers-conflict).

[↑ Back to contents](#contents)

## Links

### Project documents

- [CHANGELOG.md](CHANGELOG.md) — release history.
- [docs/spec.md](docs/spec.md) — specification and design decisions. It started as the v0.1 draft; its versions section also lists what's next and not yet built: task tiers and `risky_paths` in hooks, `SubagentStart`, the `mechanic` and `architect` agents, the `debug` and `finish` skills.
- [AGENTS.md](AGENTS.md) — rules for developing forge, for people and agents.
- [LICENSE](LICENSE) — MIT.

### Claude Code documentation

- [Hooks reference](https://code.claude.com/docs/en/hooks) — events, matchers, `decision`, `additionalContext`, `PostToolBatch`.
- [Plugins](https://code.claude.com/docs/en/plugins) and the [plugins reference](https://code.claude.com/docs/en/plugins-reference) — plugin structure and manifest.
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) — how `/plugin marketplace add` works.
- [Subagents](https://code.claude.com/docs/en/sub-agents) — agent files, `model` and tools.
- [Skills](https://code.claude.com/docs/en/skills) — `SKILL.md`, `description`, `disable-model-invocation`.
- [Memory](https://code.claude.com/docs/en/memory) — `CLAUDE.md`, `@` imports, nested files.

### Conventions

- [AGENTS.md](https://agents.md/) — the open format for agent instructions.
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — the CHANGELOG format.
- [Semantic Versioning](https://semver.org/) — version numbers.

[↑ Back to contents](#contents)

## License

MIT — see [LICENSE](LICENSE).

[↑ Back to contents](#contents)
