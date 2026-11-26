**English** · [Русский](../ru/skills.md)

← [README](../../README.md)

# Skills

Skills are Claude Code [skills](https://code.claude.com/docs/en/skills) shipped with the plugin; heavy work goes to roles through [`forge route`](routing.md#how-skills-dispatch-a-role).

**On this page:**

- [`/forge:init`](#forgeinit)
- [`/forge:mode`](#forgemode)
- [`/forge:plan`](#forgeplan)
- [`/forge:execute`](#forgeexecute)
- [`/forge:docs`](#forgedocs)
- [`/forge:review`](#forgereview)
- [`/forge:release`](#forgerelease)
- [`/forge:finish`](#forgefinish)
- [Plan task format](#plan-task-format)
- [Limitations](#limitations)

## `/forge:init`

- **Invoked by:** the user only.
- **Artifacts and state:** `.forge/profile.json`, `.forge/profile.schema.json`, `.git/info/exclude`.

[Detects the stack](profile.md#stack-detection), agrees on and writes the profile, runs `forge doctor`, then `forge docs`: on `missing-root` offers `/forge:docs`, on `missing-shim` — `forge docs --fix`. If `forge init` proposed a [`release` section](releases.md#turning-it-on), says why and offers to create a missing `CHANGELOG.md`. Asks one question: where specs and plans live — locally in `.forge/work/` (the default) or in the repository (`docs/specs/`, `docs/plans/`, committed with the code); `forge init` already proposes the repository layout when those directories exist. The answer becomes `forge init --work local|docs`.

## `/forge:mode`

- **Invoked by:** the user only, as `/forge:mode [eco|normal|max]`.
- **Artifacts and state:** `mode` in `.forge/state.json`.

Shows or switches the [mode and its table](routing.md#models-by-mode).

## `/forge:plan`

- **Invoked by:** the model (a feature or a change across several files) or the user.
- **Artifacts and state:** the spec and the plan at the paths of the profile's [`work`](profile.md#profile-fields) (by default `.forge/work/<slug>/spec.md` and `plan.md`, out of git), which the skill gets from `forge work <slug>`; `task.slug`, `stage: plan`, `tier` 2 (3 if [`risky_paths`](profile.md#profile-fields) are touched), `artifacts.spec`, `artifacts.plan`.

Context through `scout`, up to three questions, a spec of up to ~40 lines, a task plan with [roles](routing.md#roles), checks and groups for parallel runs ([format](#plan-task-format)); waits for a yes.

## `/forge:execute`

- **Invoked by:** the model or the user.
- **Artifacts and state:** `[x]` marks in `plan.md`; `stage: execute`, then `review`.

Ready tasks go to roles through `forge route`, tasks with disjoint files in parallel; a task is ticked only after its `check` passed (if the report doesn't show it, the skill runs it itself); the [retry ladder](routing.md#retry-ladder); at the end `forge verify` and `forge:review` (always at tier 3, at tier 2 unless the user declined).

## `/forge:docs`

- **Invoked by:** the model or the user.
- **Artifacts and state:** `AGENTS.md`/`CLAUDE.md` files, a backup; doesn't change the state.

Creates, migrates and splits [agent files](agent-docs.md#layout) by the "AGENTS.md is the source, CLAUDE.md imports it" layout (create, move from the root `CLAUDE.md` or other tools' rule files, split long ones, fix links). Starts with `forge docs --json`, reads the files itself, explores areas through `scout`; shows a draft and writes nothing without a yes. Before editing, copies the affected files to `.forge/work/docs-backup/<time>/` (in git, when `.forge/work/` isn't ignored, to `<git-common-dir>/forge-docs-backup/<time>/`), moves text verbatim and checks that no line was lost.

## `/forge:review`

- **Invoked by:** the model or the user.
- **Artifacts and state:** `.forge/work/<slug>/review.md` (without an active task — `.forge/work/review.md`); `stage: review`.

The base is `git merge-base` with a protected branch; reviewer through `forge route` (a diff over ~800 lines — several in parallel, by area); re-checks blocker and major findings; shows findings by severity and asks what to fix. With a `release` section the reviewer also flags a user-visible change with no `[Unreleased]` entry.

## `/forge:release`

- **Invoked by:** the model (when you ask to release) or the user.
- **Artifacts and state:** the changelog, version files, a commit and a tag; doesn't change the state.

Releases a project with a `release` section: `forge release --check`, a read of `[Unreleased]` with proposed wording fixes, the level with you, `forge release <level> --yes`, then a push only after you agree; steps specific to the project (a GitHub release, publishing, deployment) only if documented and only with your explicit approval. See [Release flow in Claude](releases.md#release-flow-in-claude).

## `/forge:finish`

- **Invoked by:** the model (when you say the branch is done — merge it, open a pull request) or the user.
- **Artifacts and state:** a merge, a push or a pull request — each only after you agree; `stage: finish`, then `forge state reset`.

Wraps up a finished branch: `git fetch` (when there is a remote), then [`forge finish`](cli.md#forge-finish) — a clean tree, the full check over the files of the branch, a base that hasn't moved and a local base that isn't behind its upstream (if it is, the skill offers to update it and checks again), a changelog entry when there is a `release` section, and the exact commands for the flow in [`git.flow`](profile.md#profile-fields). What blocks gets fixed first (a failing check is fixed, not skipped); the warnings are put to you. If `git.flow` is not set, the skill asks how the project works and offers to save the answer. It runs the printed commands one group at a time, each after your OK: the merge, the push, deleting the branch; or the push of the branch and the pull request with a title and body drafted from the spec. A push refused by forge's guard (a protected base) is reported, not worked around. At the end the task's state is reset.

## Plan task format

```markdown
- [ ] T1 <imperative title>
  role: implementer
  files: src/a.ts, src/a.spec.ts
  check: npm test -- a.spec
  depends: -
```

`role` is `implementer`, `mechanic`, `senior` or `scout`; `senior` is at most a third of the plan's tasks. Agents don't commit, push or switch branches — git stays with the main session.

## Limitations

- `risky_paths`, task tiers and `tdd` are hints for the skills in 0.3.0; the hooks don't apply them. How the skills call roles is covered in [routing limitations](routing.md#limitations).
