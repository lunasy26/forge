# Writing AGENTS.md and CLAUDE.md

Reference for forge:docs. Every agent loads these files at the start of every session, so each line costs context every time. Write what an agent can't learn quickly from the code and would get wrong without being told.

## The layout

- **`AGENTS.md`** is the single source. Codex, Cursor, Copilot and other agents read it; Claude Code reads it through the import below.
- **`CLAUDE.md`** sits next to every `AGENTS.md`. First line `@AGENTS.md`, then only what concerns Claude Code itself — at most ~30 non-empty lines (`forge docs` warns with `fat-claude` above that). Claude Code reads only `CLAUDE.md`; the import pulls `AGENTS.md` in.
- **Why the nested link matters.** Claude Code loads a nested `CLAUDE.md` on demand, when it reads files in that directory — the one-line link makes the nested `AGENTS.md` load with it. Other agents usually load only the root file of the session, so the root must send them to nested files explicitly: the routing table.
- **Claude-Code-specific** (stays in `CLAUDE.md`): `@path` imports of other files, notes on hooks, permissions, slash commands, subagents and plugins, harness quirks (e.g. "the harness may assign a `claude/*` branch — follow the git flow in AGENTS.md instead"), how to live-test a Claude Code plugin. Everything an agent of any brand needs goes to `AGENTS.md`.

## Root only, or nested files too

Start with the root file only. Add `X/AGENTS.md` when one of these holds **and** there are at least ~20 lines that apply only inside `X`:

- `X` has its own stack and manifest with its own commands: `package.json`, `*.csproj`/`*.sln`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Package.swift`, `build.gradle`;
- `X` is a package or app of a monorepo (`packages/*`, `apps/*`);
- `X` is a subsystem with its own rules — a protocol, migrations, generated code — that would take more than ~30 lines of the root.

Not one file per directory: a directory whose facts fit in one line of the directory map gets that line and nothing more. Every extra file is one more place to forget to update.

- forge itself: one package, one stack → root only (`AGENTS.md`, 85 lines).
- A .NET backend plus an Angular frontend in one repo: root (orientation, shared rules, git flow, routing) + `backend/AGENTS.md` + `web/AGENTS.md`, each with stack, commands, layout, conventions, tests, gotchas.

## Root AGENTS.md

In roughly this order:

1. **Title and orientation** — 2–4 lines: what the project is, the main stack, how the parts fit together. Then one line saying this is the canonical memory for all agents and that `CLAUDE.md` imports it — edit here.
2. **Routing table** — when there are nested files or reference docs an agent must open for certain tasks (format below).
3. **Directory map** — one line per top-level directory and key file, as a table or a code block. Name every top-level directory: forge's end-of-turn reminder treats a new directory missing from the root file as a structure change.
4. **Common commands** — build, test, a single test, lint, run; exact, as defined in manifests and CI, in a code block with short comments. Include every command of the forge profile's `verify.steps` (`verify-undocumented` checks this).
5. **Cross-cutting rules and invariants** — what holds everywhere, each with its reason. One line of *why* lets an agent handle the case the rule didn't foresee.
6. **Git flow** — branch names, commit message format, how changes reach the main branch, what never to commit.
7. **Gotchas / do not** — short list of traps that cost someone time.

Optional when the project has them: changelog rules, where design decisions live, links to other systems.

## Nested AGENTS.md

- Title `# <Project> — <area>`, then one line: the root `AGENTS.md` holds the shared rules, this file adds the `<area>` specifics.
- Sections as the area needs: Stack, Commands (say which directory to run them from), Layout, Architecture, Conventions, Testing, Gotchas.
- Don't repeat the root. One fact, one place.
- Next to it, a `CLAUDE.md` containing `@AGENTS.md` — `forge docs --fix` creates it.

## Routing table

```markdown
## Where to look

| When | Read |
|---|---|
| Any change in `backend/` | `backend/AGENTS.md` — .NET stack, commands, architecture, tests |
| Any change in `web/` | `web/AGENTS.md` — frontend stack, commands, design system |
| Local setup | `docs/operations/local-deploy.md` |
```

- **When** is a path or a kind of task; **Read** is the file plus a few words on what is in it, so the agent can tell whether it needs to open it.
- Name each nested file by its path from the root (`backend/AGENTS.md`). `forge docs` warns (`unlisted`) when a nested `AGENTS.md` isn't mentioned in its parent file.
- Markdown links `[text](path)` resolve relative to the file that contains them (`/path` from the project root) and are checked (`broken-link`). Paths in backticks are not checked — keep them accurate.

## What not to write

- What the code, README or configs already say: dependency lists, every script, API descriptions, the README's setup steps. Link instead.
- Task status, plans, TODOs, "currently working on" — they go stale within days; they belong in the backlog, issues or plan files.
- Secrets, tokens, credentials, personal data.
- Long retellings of the architecture or history; generic advice the model follows anyway ("write clean code", "add tests").

## Size

Aim for at most ~150 lines per file; the hard limit is `docs.max_lines` in the profile (default 200, `too-long` above it). Every line is loaded into every session, and a long file dilutes the rules that matter. When a file grows past the target: first cut what the list above covers, then move area-specific sections to nested files, then move long reference material (deployment, configuration keys) to `docs/` with a row in the routing table.

## Language

Use the language of the project's documentation and commit messages; if they differ or there are none, ask the user. Commands, paths and identifiers stay as they are.

## Example: forge's own files

`AGENTS.md` (85 lines, root only — no nested files, so no routing table):

- `# AGENTS.md — forge` — one line: who the file is for, links to README (user docs) and `docs/spec.md` (rationale).
- **Ориентация** — Node plugin without dependencies, thin hooks over `lib/`, skills as markdown; a directory table, one line per directory.
- **Команды** — all tests, one file, one test by name, the CLI against a temp project, a hook by hand; one gotcha about `CLAUDE_PROJECT_DIR`.
- **Инварианты и соглашения** — zero dependencies, output language, fail-open vs fail-closed hooks with the reason, hook time budget, state access, routing invariants, rules for skills and agents.
- **Тесты** — unit vs end-to-end, fixtures, what each kind of change must cover.
- **Git** — branch names, commit format, local merge to `main`, the local profile that allows the push.
- **CHANGELOG** — when an entry is needed, release steps.
- **Где решения** — spec, feature designs, README.

`CLAUDE.md` (5 lines): `@AGENTS.md`; one line "all project memory is in AGENTS.md — edit it there"; one Claude-Code-only paragraph on live-testing the plugin with `claude --plugin-dir .` and when edits take effect.
