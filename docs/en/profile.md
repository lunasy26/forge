**English** · [Русский](../ru/profile.md)

← [README](../../README.md)

# Profile

The project profile is `.forge/profile.json`. [`forge init`](#stack-detection) writes it together with a copy of the schema.

**On this page:**

- [Example](#example)
- [Profile fields](#profile-fields)
- [Broken profile](#broken-profile)
- [Profile in a worktree](#profile-in-a-worktree)
- [Stack detection](#stack-detection)
- [What init writes](#what-init-writes)

## Example

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

## Profile fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `$schema` | string | — | `forge init` writes `./profile.schema.json` |
| `version` | `1` | — | Format version |
| `commands` | object: name → string or `{ "run": string, "ext": [".ext"] }` | `{}` | Shell commands, written in POSIX `sh` syntax: they run in `/bin/sh`, on Windows in Git Bash (from Git for Windows; without it format, lint and the check are skipped, not failed: the user gets a [one-time notice](hooks.md#which-shell-runs-the-commands), and [`forge doctor`](cli.md#commands) says so). `format` and `lint` run in [`PostToolBatch`](hooks.md#format-and-lint); `test_fast` replaces `test` in a fast check; any name can be used in `verify.steps` |
| `verify.steps` | string[] | `[]` | Names from `commands`, in order ([Verification on Stop](hooks.md#verification-on-stop)). An empty list means no auto-verification. A step missing from `commands` is dropped with an error |
| `verify.on_stop` | `off` \| `fast` \| `full` | `fast` | `off` — Stop doesn't verify; `fast` — `test_fast` instead of `test`; `full` — steps as they are |
| `verify.timeout_sec` | integer 1–540 | `300` | Total budget of one check across all steps |
| `git.protected_branches` | string[] | `["main", "master"]` | [Branches](guards.md#protected-branches) you can't push to. **Replaces** the built-in list rather than extending it; `[]` removes branch protection |
| `protected_files` | string[] | `[]` | **Appended** to the [built-in list](guards.md#file-guard); `!pattern` removes protection. Matching is case-insensitive (`.ENV` and `KEY.PEM` are protected too) |
| `risky_paths` | string[] | `[]` | Hooks don't apply it. Read by [`forge:plan`](skills.md#forgeplan): work here is tier 3 and the `senior` role |
| `tdd` | `off` \| `encouraged` \| `required` | `encouraged` | Used by [skills](skills.md): with `required`, `forge:plan` puts test tasks before implementation, and `forge:execute` passes the setting to the implementer. Hooks don't apply it |
| `docs.remind` | boolean | `true` | `false` turns off the [reminder about agent files](agent-docs.md#agent-docs-reminder) at the end of a turn; [`forge docs`](agent-docs.md#the-forge-docs-command) always works |
| `docs.max_lines` | integer > 0 | `200` | An agent file longer than this gets the [`too-long`](agent-docs.md#issue-codes) warning |
| `docs.watch` | string[] | built-in list | **Appended** to the built-in list (see [What counts as a change](agent-docs.md#what-counts-as-a-change)); [syntax](guards.md#pattern-syntax) as for `protected_files`, `!pattern` removes an entry, a built-in one included (`"!Makefile"`) |
| `release` | object | absent | Turns on [releases and the changelog](releases.md). Without it none of that is active; `{}` turns it on with the defaults below |
| `release.changelog` | string | `CHANGELOG.md` | Path to the changelog from the project root. The format is Keep a Changelog |
| `release.tag_prefix` | string | `v` | Prefix of the git tag of a version (`v1.2.3`); `""` gives `1.2.3` |
| `release.version_files` | (string \| `{ "path", "pattern" }`)[] | `[]` | Files that hold the version, kept in sync by `forge release`: a path (the handler is picked by the file name) or a path with a `pattern` with one capture group. See [Version files](releases.md#version-files). Empty means the version lives in the changelog and tags only |
| `release.remind` | boolean | `true` | `false` turns off the [reminder about an empty `[Unreleased]`](releases.md#reminder-about-an-empty-unreleased); `forge release` always works |
| `release.ignore` | string[] | built-in list | **Appended** to the built-in list of files whose edits need no changelog entry: `test/**`, `tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `docs/**`, `*.md`, `**/*.md`, `.forge/**`; [syntax](guards.md#pattern-syntax) as for `protected_files`, `!pattern` removes an entry, a built-in one included (`"!docs/**"`) |
| `language` | `auto` \| `en` \| `ru` | `auto` | Language of forge's messages. `auto` — the language you write in, see [Message language](hooks.md#message-language) (falls back to English); `en` or `ru` — always that language. The `FORGE_LANG` environment variable wins over the profile |
| `mode` | `eco` \| `normal` \| `max` | `normal` | Default [mode](routing.md#models-by-mode); the mode set by `forge mode` is stored in the state and wins over the profile |
| `routing` | `{ mode: { role: "model/effort" } }` | `{}` | Overrides of the model table, see [Routing overrides](routing.md#routing-overrides) |

## Broken profile

A broken profile doesn't block work. The profile is laid over the defaults. Invalid JSON — all defaults apply; an invalid field — the default for that field, the rest is applied. The errors are shown by [`forge doctor`](cli.md#commands) and (as a count) by [session start](hooks.md#session-start-context).

## Profile in a worktree

`.forge/` is not committed, so a new linked worktree (for example `.claude/worktrees/<name>`, which Claude Code creates) has no profile of its own. Then forge reads the main checkout's profile: guards, checks, lint and routing overrides work as they do there. The worktree's own profile wins — `forge init` in a worktree creates one. The inherited profile is only read; state, the edit journal and plans are the worktree's [own](state.md#edit-journal). [`forge doctor`](cli.md#commands) prints `✓ Profile from the main checkout <path>`, and [session start](hooks.md#session-start-context) adds the same line.

forge finds the main checkout from the `.git` and `commondir` files without starting a process; for a bare repository or a separate git directory it uses the first entry of `git worktree list`. A worktree of a bare repository has no main checkout, and a submodule inherits nothing either. A committed profile is present in every worktree, so it needs no inheritance.

## Stack detection

`forge init` picks the first stack found in the order below; the others go to the notes. `verify.steps` are those of `typecheck`, `lint`, `test` that were found. Branches are `main`, `master` and `origin`'s default branch; `risky_paths` are `**/migrations/**`, `.github/workflows/**`. Separately from the stack, `forge init` proposes a [`release` section](releases.md#turning-it-on) if the project looks like one that cuts releases.

| Stack | Signals | Commands |
|---|---|---|
| Node/TS | `package.json`; npm, pnpm, yarn or bun by lock file | `format`: prettier or biome; `lint`: eslint on files or the `lint` script; `typecheck`: the `typecheck`/`type-check` script or `tsc --noEmit` with `tsconfig.json`; `test`: the `test` script; `test_fast`: `vitest related` or `jest --findRelatedTests` |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`; prefix `uv run` or `poetry run` by lock file | ruff format and check, mypy or pyright, `pytest -q` |
| Swift | `Package.swift`, `*.xcodeproj`, `*.xcworkspace` | swiftformat and swiftlint when their configs exist, `swift test` for SwiftPM; `on_stop: "off"` — tests are slow |
| Go | `go.mod` | `gofmt -w {files}`, `go vet ./...`, `go test ./...` |
| Rust | `Cargo.toml` | `rustfmt {files}`, `cargo clippy`, `cargo test` |

## What init writes

| Path | Contents | In git |
|---|---|---|
| `.forge/profile.json` | project [profile](#profile-fields) | your call |
| `.forge/profile.schema.json` | copy of the schema; the profile points to it with `"$schema"` for editor completion | together with the profile |
| `.git/info/exclude` | lines `.forge/state.json`, `.forge/edits.jsonl`, `.forge/work/`, `.forge/log/` | — |

The excludes go to `info/exclude` of the common git directory (so they apply in every worktree); the project's `.gitignore` is not touched. A committed profile gives everyone who has forge the same checks and guards; commit it together with `profile.schema.json`.
