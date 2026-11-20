**English** · [Русский](../ru/agent-docs.md)

← [README](../../README.md)

# Agent files

The agent files are `AGENTS.md` and `CLAUDE.md`. forge keeps a layout in which the text lives in one place and every tool reads it.

**On this page:**

- [Layout](#layout)
- [The forge docs command](#the-forge-docs-command)
  - [Issue codes](#issue-codes)
  - [Fixing and JSON output](#fixing-and-json-output)
- [Agent docs reminder](#agent-docs-reminder)
  - [What counts as a change](#what-counts-as-a-change)
  - [What clears a reminder](#what-clears-a-reminder)
  - [Reminder memory](#reminder-memory)
  - [Order and when it stays quiet](#order-and-when-it-stays-quiet)
- [Limitations](#limitations)

## Layout

- **`AGENTS.md` is the source.** The root `AGENTS.md` is the project map: what it is, directories, commands, rules, a table of areas with links to nested files. Codex, Cursor and other agents read it (see [agents.md](https://agents.md/)).
- **`CLAUDE.md` is the import.** Next to every `AGENTS.md` lies a `CLAUDE.md` consisting of one line, `@AGENTS.md` (after it you may add what only Claude Code needs). Claude Code reads `CLAUDE.md`, not `AGENTS.md` (see [memory](https://code.claude.com/docs/en/memory)), so without that line it never sees the text.
- **Nested files.** A large area (a monorepo package, a subsystem with its own commands and rules) gets its own `AGENTS.md` and the same `CLAUDE.md` shim. Claude Code loads a nested `CLAUDE.md` on demand, when it reads files in that directory — so the shim is needed in nested directories too: without it the area's rules are not picked up. The root `AGENTS.md` must mention the area's directory (`backend/`, `` `backend` ``), otherwise other agents won't know about it.

[`/forge:docs`](skills.md#forgedocs) helps create, migrate and repair the files; [`forge docs`](#the-forge-docs-command) checks the structure; the [reminder at the end of a turn](#agent-docs-reminder) catches staleness.

## The forge docs command

`forge docs [--fix] [--json]` checks the structure of the agent files deterministically, without a model. It works without a profile too (with defaults). Directories with agent files are found like this: in a git repository with `git ls-files` (tracked and untracked, without ignored files), otherwise with a directory walk up to depth 6 and 20 000 entries. Skipped are hidden directories, `node_modules`, `vendor`, `dist`, `build`, `target`, `bin`, `obj`, `.venv`, `venv`, `__pycache__`, `Pods`, `DerivedData`; the walk doesn't follow symbolic links to directories but sees links to files. The `.forge/` directory is never scanned (it holds the `/forge:docs` backups). Whether a found directory has `AGENTS.md` and `CLAUDE.md` is decided on disk: a git-ignored file next to a found one counts too. A `CLAUDE.md` that is a symbolic link to the neighbouring `AGENTS.md` counts as a correct import, just like `@AGENTS.md`.

The output is lines `✗ <path>: <message> [<code>]` (error) and `! <path>: <message> [<code>]` (warning); with no issues — `✓ Агентские файлы в порядке` ("agent files are in order"). Exit code 1 if there is at least one error (`✗`); warnings (`!`) don't change it. An unknown argument gives exit code 2.

[`forge doctor`](cli.md#commands) adds a line: `✓ Агентские файлы в порядке`, or `✗`/`!` `Агентские файлы: N замечаний — forge docs` ("agent files: N issues — forge docs", with Russian plural agreement: 1 замечание, 2 замечания); `!` if all issues are warnings. The exit code of `doctor` doesn't change — it is always 0.

### Issue codes

| Code | Level | When | `--fix` |
|---|---|---|---|
| `missing-root` | error | No root `AGENTS.md` (if the root `CLAUDE.md` has content, the message asks to move it into `AGENTS.md`) | no, use `/forge:docs` |
| `missing-shim` | error | `AGENTS.md` exists, no `CLAUDE.md` next to it | yes: creates `CLAUDE.md` with `@AGENTS.md` |
| `no-import` | error | Both files exist, but `CLAUDE.md` has no `@AGENTS.md` line outside a code block (or `CLAUDE.md` can't be read) | yes, only if `CLAUDE.md` was read and is empty: replaces it with the import; with content — add the line yourself |
| `claude-only` | warning | A nested directory has a `CLAUDE.md` with content and no `AGENTS.md` | no |
| `fat-claude` | warning | `CLAUDE.md` has more than 30 non-empty lines, not counting `@AGENTS.md` | no |
| `too-long` | warning | The directory's agent file (`AGENTS.md`, otherwise `CLAUDE.md`) is longer than [`docs.max_lines`](profile.md#profile-fields) lines | no |
| `unlisted` | warning | A nested `AGENTS.md`, and the nearest agent file above doesn't mention its directory (`dir/` or `` `dir` ``) | no |
| `broken-link` | warning | A Markdown link `[…](path)` points to a path that doesn't exist. External URLs, `#anchors`, links in code blocks and in backticks are not checked; `/path` is relative to the root, others to the file's directory | no |
| `verify-undocumented` | warning | The command of a step from [`verify.steps`](profile.md#profile-fields) (its first one or two words: `npm test`, `pytest`; three for `npm`/`pnpm`/`yarn`/`bun run <script>`; leading assignments `FOO=1` and `cd <dir> &&` are skipped) appears in no agent file. Not checked when there are no agent files | no |
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

## Agent docs reminder

After the check, `Stop` decides whether `AGENTS.md` and `CLAUDE.md` may be stale (the layout is in [Layout](#layout)). The reminder is a `decision: "block"` with this reason:

```
forge: в этой задаче изменились команды или структура: … Проверь, не устарели ли … — команды, карта каталогов, правила. Если обновлять нечего — так и скажи и заверши работу.
```

("commands or structure changed in this task: … Check whether … are stale — commands, directory map, rules. If there is nothing to update, say so and finish.") The text is short (at most about 520 characters): the lists of changes and files are cut to «… и ещё N» ("… and N more"). It can be turned off with [`docs.remind: false`](profile.md#profile-fields).

### What counts as a change

The files from the [edit journal](state.md#edit-journal) after the `docs.offset` cursor are taken. A change is one of two things:

- the file matches [`docs.watch`](profile.md#profile-fields) (by default `package.json`, `pyproject.toml`, `Cargo.toml`, `*.sln`, `Makefile`, `justfile`, `Taskfile.yml`, `docker-compose*.yml`, `compose*.yml`, `.github/workflows/**`, `.gitlab-ci.yml`; a pattern without `/` applies at any depth). A `package.json` in git counts only if its `scripts` differ from `HEAD` (key order doesn't matter; absent in `HEAD` or not readable as JSON — it counts), so a dependency edit stays quiet. Git is resolved for each `package.json` from its own directory (`git -C <dir>`): a project without git at the root with repositories in subfolders, and a nested repository or submodule inside a git project, are compared with their own `HEAD`. Outside git any edit of `package.json` counts; in a repository without commits every `package.json` is "new";
- in git: the file lies in a top-level directory that isn't in `HEAD`, and the root `AGENTS.md` doesn't mention it (`name/` or `` `name` ``). Hidden directories, files in the root, git-ignored files and a project without commits don't count; one directory is one change, shown in the text as «новый каталог name/» ("new directory name/"). Outside git there is no such signal.

### What clears a reminder

An edit, in the same window, of an `AGENTS.md` or a `CLAUDE.md` with content (not an `@AGENTS.md` import) in the directory of the changed file or in any of its ancestors; an edit of the root file clears everything. The reminder names the agent file nearest to the change (`AGENTS.md`, otherwise `CLAUDE.md`, otherwise the root `AGENTS.md`).

### Reminder memory

forge remembers in [`state.json`](state.md#state-file) (`docs.reminded`) what it has already reminded about: a fingerprint of `scripts` for each `package.json`, and the names of new top-level directories. A signal that hasn't changed since its reminder (or was cleared by an agent file edit) doesn't remind again: after a reminder about `scripts`, a dependency-only edit stays quiet, and so do new files in an already named directory. Different `scripts` (a different fingerprint) or another new directory remind again. An entry is forgotten when the signal matches `HEAD`: `scripts` equal the committed ones again, the directory is committed or mentioned in the root `AGENTS.md`.

### Order and when it stays quiet

- After every stop the `docs.offset` cursor moves to the end of the journal, so the same edits are not examined twice. This is one window shared with the [reminder about an empty `[Unreleased]`](releases.md#reminder-about-an-empty-unreleased): both read the same files, and when both fire the reasons go into one block.
- [Verification](hooks.md#verification-on-stop) comes first. If the check failed (`decision: "block"`), there is no reminder, the cursor stays, and the reminder comes after the next passing check. If the check released the session after three failures, there is no reminder either (the cursor stays). The one-off message «последняя проверка не прошла» ("the last check failed") may come together with a reminder in one answer.
- It stays quiet without a profile, while background subagents or workflows are running, if there is no `AGENTS.md` either in the root or in the directories above the changed files (checked before any git calls), and with `docs.remind: false`. When this reminder is off and the release reminder is off too (or there is no `release` section), `Stop` deletes `state.docs`, so that an old cursor doesn't hold back the journal reset; if only one of them is off, the shared cursor stays. `verify.on_stop: "off"` doesn't turn the reminder off.
- An error inside the reminder is logged and doesn't affect the check result: its `decision`/`systemMessage` is returned as usual.
- The first stop after updating forge (no cursor yet) only records the cursor: edits made before it are not reminded about.
- The cursor takes part in [resetting the edit journal](state.md#edit-journal).

## Limitations

- The reminder sees only edits made with edit tools: a command changed through Bash won't trigger it (see [hook limitations](hooks.md#limitations)).
- Reminder signals are computed against the `HEAD` of their own repository, and repeats are suppressed by the [reminder memory](#reminder-memory) (`docs.reminded`): the same `scripts` fingerprint and the same new directory don't remind twice. The memory sees only `scripts` and directory names: other files from `docs.watch` (workflows, `Makefile`) remind on every edit in a new window, unless an agent file is edited in the same window.
- Without git the signals are coarser: the first edit of `package.json` counts as a change of commands even if only dependencies changed (after that, only a change of `scripts`); there is no new-directory signal. In a repository without commits every `package.json` counts as new (the first edit reminds), and there is no new-directory signal either.
- `docs.watch` doesn't look at file contents, except `scripts` in `package.json`.
- [`forge docs`](#the-forge-docs-command) checks structure, not meaning: it doesn't find stale commands and paths in the text (except `broken-link` and `verify-undocumented`). That is the job of `/forge:docs`. `--fix` repairs `fixable` issues only for `CLAUDE.md`.
