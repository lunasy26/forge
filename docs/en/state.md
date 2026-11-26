**English** · [Русский](../ru/state.md)

← [README](../../README.md)

# Files and state

What forge keeps under `.forge/` in the project root. Which of these files [`forge init`](profile.md#what-init-writes) creates and which go to `.git/info/exclude` is on the profile page.

## The .forge directory

```
.forge/
├── profile.json          profile (commit it if you like)
├── profile.schema.json   copy of config/profile.schema.json
├── state.json            session state                           ┐
├── edits.jsonl           edit journal                            │ in .git/info/exclude
├── work/<slug>/          review.md, spec/plan (default)          │
└── log/errors.log        internal hook errors                    ┘
```

## State file

`state.json`: `tier` (0–3, default 1), `stage`, `mode` (`null` — from the profile), `task.slug`, `artifacts.spec` and `artifacts.plan`, `verify` (`at`, `ok`, `summary`, `failed_step`, `edits_offset`, `notified`; `ok` is `null` when the check was skipped because there is no [Git Bash](hooks.md#which-shell-runs-the-commands), and then `notified` is already `true`), `failures.verify_streak`, `lint_offset`, `docs.offset` (the cursor shared by both [Stop reminders](hooks.md#reminders-at-the-end-of-a-turn)), `docs.reminded` ([reminder memory](agent-docs.md#reminder-memory)) and `release.reminded` (the keys of the [release reminder](releases.md#reminder-about-an-empty-unreleased): a list of at most 20 strings), `shell_missing_notified` (top level: `true` once the user has been told that format, lint and the check are skipped for lack of Git Bash; cleared when a verification run executes commands again, so a later loss is announced again) and `lang` (`en` or `ru`: the language of your latest message, which the `Stop` hook remembers in a project with a profile so that the CLI, which has no transcript, can [answer in it](hooks.md#message-language)). It changes only through [`forge state`](cli.md#commands) and the hooks; a corrupted file is replaced with defaults. `forge state set`, `forge state reset` and `forge mode <mode>` create it even without a profile.

## Edit journal

`edits.jsonl`: one line `{"t": <ms>, "f": "<path from the root>"}` per edit. [Lint](hooks.md#format-and-lint), [verification](hooks.md#verification-on-stop) and the [Stop reminders](hooks.md#reminders-at-the-end-of-a-turn) keep their own byte cursors (`lint_offset`, `verify.edits_offset`, `docs.offset`; the agent docs and release reminders share the last one). When all active cursors have reached the end and the journal is at least 256 KB, it is truncated and the cursors are reset to 0. The `docs.offset` cursor may be absent (the first stop after an update; when both reminders are off `Stop` deletes `state.docs`) — then it doesn't hold back the reset; while it exists and lags behind, the journal is kept.

There is one state per working directory. Run parallel sessions in separate worktrees. In a linked worktree without its own profile forge [reads the main checkout's profile](profile.md#profile-in-a-worktree), but `state.json`, the edit journal, `log/` and the `work/` plans are the worktree's own: its `.forge/` directory appears on the first write. By default (the profile's [`work`](profile.md#profile-fields) is unset) the spec and the plan live in `.forge/work/<slug>/`, so to continue a main-checkout plan in a worktree, copy that directory. A plan kept in the repository (`work` preset `docs`) is committed and arrives in the worktree with the branch; only `review.md` stays local.

## Limitations

- The edit journal is reset only when all active cursors have caught up (`verify.edits_offset`, `lint_offset`, `docs.offset` if present; the last one is shared by both Stop reminders). The cursor of a consumer that doesn't run (no `format`/`lint` commands, `verify.on_stop: "off"`) stays at 0 and prevents the reset — this was the case before `forge docs` as well. A verification skipped for lack of a shell keeps `verify.edits_offset` where it was, but does not hold the journal past the size limit.
- One session per working directory: two sessions in one checkout share `.forge/state.json` and the edit journal.
- Only edit tools write to the journal ([hook limitations](hooks.md#limitations)).
