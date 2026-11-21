**English** · [Русский](../ru/hooks.md)

← [README](../../README.md)

# Hooks

Each hook is `node hooks/<name>.mjs`: it reads the event JSON on stdin and writes its answer to stdout. Hook events and output fields are described in the Claude Code [hooks reference](https://code.claude.com/docs/en/hooks). The two `PreToolUse` guards have their own page: [Guards](guards.md).

**On this page:**

- [Hook table](#hook-table)
- [Fail-open and fail-closed](#fail-open-and-fail-closed)
- [Session start context](#session-start-context)
- [Format and lint](#format-and-lint)
- [Verification on Stop](#verification-on-stop)
- [Reminders at the end of a turn](#reminders-at-the-end-of-a-turn)
- [Message language](#message-language)
- [Limitations](#limitations)

## Hook table

| Event | Matcher | Script | What it does | Timeout, s |
|---|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | `session-start.mjs` | [Short context](#session-start-context): mode, tier, checks, active task, warnings, a line about the root agent files | 10 |
| `PreToolUse` | `Bash` | `pre-bash.mjs` | [Bash guard](guards.md#bash-guard) for git and `rm -r`: `deny` or `ask` with a reason | 10 |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `pre-edit.mjs` | [File guard](guards.md#file-guard): `deny` for `protected_files` | 10 |
| `PostToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | `post-edit.mjs` | Appends the path to the [edit journal](state.md#edit-journal) `.forge/edits.jsonl`; does nothing without a profile | 10 |
| `PostToolBatch` | — | `post-batch.mjs` | [`format` and `lint`](#format-and-lint) on the files changed since the last run | 180 |
| `Stop` | — | `stop.mjs` | [`verify.steps`](#verification-on-stop) if there were edits since the last check; then, over one window of edits, the [reminder about agent files](agent-docs.md#agent-docs-reminder) (commands or structure changed) and the [reminder about an empty `[Unreleased]`](releases.md#reminder-about-an-empty-unreleased) (only with a `release` section); both reasons go into one block | 600 |

What the guard hooks answer (silence, `deny` or `ask`) is described on the [Guards](guards.md) page.

## Fail-open and fail-closed

On an internal error a hook writes it to the log and exits with code 0 and no output (fail-open): a forge failure never blocks your work. The log is `.forge/log/errors.log` if the project has `.forge/`, otherwise `forge-errors.log` in the system temp directory; [`forge doctor`](cli.md#commands) shows the latest errors.

The exception is the guard hooks `pre-bash` and `pre-edit`: if the check itself breaks, they answer `ask` and write the error to the same log (fail-closed). The reason is `forge: internal error while checking the command (details in the forge error log) — cannot confirm it is safe. Confirm.` (for `pre-edit`: `forge: internal error while checking protected files (details in the forge error log) — cannot confirm the edit is allowed. Confirm.`). Unreadable JSON on stdin still means a silent exit: there is nothing to check.

## Session start context

On `startup`, `resume`, `clear`, `compact`:

- no profile and not a git repository — nothing, not even the Superpowers warning (the hook exits right away);
- a git repository without a profile — one line suggesting `/forge:init`;
- with a profile — a line with the mode (from the state, otherwise from the profile), tier, verification steps, `on_stop` and a reminder about `forge route <role>`; in a linked worktree using the main checkout's profile, the line `Profile from the main checkout <path>…` ([Profile in a worktree](profile.md#profile-in-a-worktree)); when needed, lines about the active task (slug, stage, path to the plan), a failed last check, the number of [profile errors](profile.md#broken-profile) and ignored [`routing` overrides](routing.md#routing-overrides);
- with a profile and no root `AGENTS.md` — the line `forge: no AGENTS.md: /forge:docs can create one.`; if there is a `CLAUDE.md` that doesn't import `AGENTS.md` (no `@AGENTS.md` line outside a code block) — `forge: CLAUDE.md does not import AGENTS.md: forge docs.`. Only these two files are checked, without walking directories; a `CLAUDE.md` that is a symbolic link to `AGENTS.md` counts as an import; with a correct pair there is no line;
- the [Superpowers warning](../../README.md#superpowers-conflict), if it is enabled — in a git repository, with or without a profile.

The whole text is cut to 600 characters.

## Format and lint

`PostToolUse` appends every edited file to the [edit journal](state.md#edit-journal) `.forge/edits.jsonl` — append only, so parallel hooks don't get in each other's way. `PostToolBatch` fires once after a batch of tool calls:

1. no profile, or neither [`commands.format`](profile.md#profile-fields) nor `commands.lint` — does nothing;
2. takes the files from the journal after the `lint_offset` cursor (unique, existing, inside the project) and moves the cursor;
3. runs `format`, then `lint`, until the first failure; the total budget is 150 s;
4. on failure returns `additionalContext`: the step, the command and up to 40 lines of output (head and tail). Claude gets it as context before its next step; the turn is not interrupted (`decision: "block"` on this event would stop the loop, and Claude would never see the reason).

`{files}` in a command is replaced with the shell-quoted list of files; `ext` keeps only files with those extensions; if no files are left, the step is skipped. A command without `{files}` runs as is, over the whole project, after every batch with edits. Commands run through `/bin/sh -c` in the project root with `CI=1`, `FORCE_COLOR=0`, `NO_COLOR=1`. Lint also works with [`verify.on_stop: "off"`](#verification-on-stop).

The context starts with `forge: after your edits` and ends with `Fix this before the next steps.`.

## Verification on Stop

The `Stop` hook:

- does nothing without a profile, and while background subagents or workflows are still running — the check happens when they finish. With [`verify.on_stop: "off"`](profile.md#profile-fields) or empty `verify.steps` it skips only the check: the [reminders](#reminders-at-the-end-of-a-turn) still work;
- if the edit journal grew since the last check, runs `verify.steps` in order until the first failure, within a total budget of `verify.timeout_sec`. With `on_stop: "fast"` the `test` step is replaced with `test_fast`, if it is set and has something to check. Steps with `{files}` get the files changed since the last check;
- records the result in [`.forge/state.json`](state.md#state-file) (`verify`, `failures.verify_streak`): success resets the failure counter, a failure increments it. [`forge verify`](cli.md#commands) keeps the same counter;
- on success the turn ends silently; on failure it answers `decision: "block"`: Claude gets the step, the command, up to 60 lines of output and an instruction to fix it or tell the user honestly that the check fails.

The block reason starts with `forge: the check before finishing failed.` and ends with `Fix it and finish again. If it cannot be fixed, tell the user honestly that the check fails.`.

### Failure streak

| Failures in a row | Behaviour |
|---|---|
| 1 | Doesn't let the turn end; shows Claude the output |
| 2 or more | The same, plus an instruction to hand the task to the [`debugger`](routing.md#roles) role (`forge route debugger`) together with the log |
| 3 or more, on a repeated stop (`stop_hook_active`) | Doesn't block: the user gets the message `forge: the check has failed N times in a row, so auto-verify is letting the session go. Step: …` |

If there are no new edits, but the last check failed and the user hasn't been told yet, the hook shows them a summary once: `forge: the last check failed (…)`. So a stop without new edits after a failure doesn't loop.

## Reminders at the end of a turn

After verification, `Stop` runs two one-shot reminders over one shared window of edits (the journal after the `docs.offset` cursor):

- the [agent docs reminder](agent-docs.md#agent-docs-reminder) — when the turn changed commands or project structure;
- the [reminder about an empty `[Unreleased]`](releases.md#reminder-about-an-empty-unreleased) — only with a `release` section in the profile, when code changed and `[Unreleased]` has no entries.

If both fire, Claude gets one `block` with both reasons. Verification comes first: after a failed check there is no reminder. The details — what counts as a change, what clears a reminder, when they stay quiet — are on the pages of each reminder.

## Message language

forge shows its messages in English or Russian. Each hook and each CLI call picks the language once, at start, from the first source that gives an answer:

1. the `FORGE_LANG` environment variable (`en` or `ru`);
2. the [`language`](profile.md#profile-fields) field of the profile, if it is `en` or `ru` (`auto` means "keep looking");
3. your latest message in the session transcript (`transcript_path` of the hook event; the last 8 MB are read). Code blocks (including an unclosed one), pasted text (`<pasted_content>`), log and stack-trace lines, inline code and URLs are ignored, and only the first 16 KB is analysed; if Cyrillic makes up at least 0.3 of the remaining letters, the language is Russian, otherwise English. A message with fewer than 3 letters ("да", "ok") tells nothing, so your previous message is used, and if there is none the search goes on. What Claude Code writes itself is not your message: tool results, command wrappers, system reminders, background task notifications, the summary after compaction, `!` commands and their output, hook output, interruption markers and IDE context (opened file, selection); for a slash command its arguments count;
4. `lang` in the [state](state.md#state-file): the `Stop` hook stores the language of your latest message there (only in a project with a profile), and the CLI, which has no transcript, reads it. The hooks use it too when the session has no message of yours yet (the first event of a new session);
5. the system locale: `LC_ALL`, `LC_MESSAGES` or `LANG` starting with `ru` gives Russian;
6. English.

An unknown value in `FORGE_LANG` or in `language` is skipped as if it were not set.

What is translated: CLI output (including `forge init` notes and the `forge doctor` report), the reasons of the guard hooks, the context and reasons of the other hooks, profile validation errors, the issues of [`forge docs`](agent-docs.md#issue-codes) and [`forge release --check`](releases.md#changelog-checks). What is not: the error log `.forge/log/errors.log` (always English), data that forge quotes (command output, file paths, changelog entries, the profile's own text), and the skills and agents, which are written in English: Claude answers in your language anyway.

The messages quoted on the English pages are the English ones; the Russian pages quote the Russian ones. How to add a message is on the [Development](development.md#adding-a-message) page.

## Limitations

- The [edit journal](state.md#edit-journal) is written only by edit tools. Changes made only through Bash (code generation, `sed -i`, `git apply`) trigger neither [lint](#format-and-lint) nor [verification at the end of a turn](#verification-on-stop). The reminders have the same blind spot (see the limitations of [agent files](agent-docs.md#limitations) and [releases](releases.md#limitations)).
