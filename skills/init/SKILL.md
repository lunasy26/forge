---
name: init
description: Set up forge in the current project — detect the stack and create .forge/profile.json with verification commands, protected branches and files. Use when the user runs /forge:init or asks to set up forge for a project.
disable-model-invocation: true
---

# forge:init

1. Run `forge init`. It prints the detected stack, the proposed profile and notes, without writing anything.
2. Show the user a short summary: stack, verification steps and what runs when you finish a turn (`verify.on_stop`), protected branches, risky paths. Ask only about what the notes flag as unknown (for example an Xcode test command) or what looks wrong for this project.
3. Ask one question: where do specs and plans live — locally in `.forge/work/` (out of git, the default), or in the repository (`docs/specs/`, `docs/plans/`, committed and reviewed with the code)? `forge init` already proposes the repository layout when those directories exist — say so in the question.
4. Write the profile with `forge init --yes --work local|docs`, per the answer. For a different layout, or other changes, edit `.forge/profile.json` afterwards — the schema next to it gives field descriptions; `work` takes path templates with `{slug}` and an optional `{date}`.
5. Run `forge doctor` and report any ✗ lines, except the agent-files line — step 6 covers it.
6. Run `forge docs` to see whether the project's agent files (`AGENTS.md`, `CLAUDE.md`) are set up — every session starts from them. If it reports `missing-root`, offer `/forge:docs` in one line: it drafts the files from the project and writes them only after the user's OK. Otherwise, if it reports `missing-shim`, offer `forge docs --fix`: it only creates one-line `CLAUDE.md` files with `@AGENTS.md`, so Claude Code reads the existing `AGENTS.md`. Run neither without a yes; leave other findings to `forge docs`.
7. If `forge init` proposed a `release` section, mention it in the summary: why it was detected (CHANGELOG, version tags, CI that publishes) and which version files it will keep in sync. It is opt-in and enables `/forge:release`, a changelog check and a reminder when code changed but `[Unreleased]` is empty. If the project has no `CHANGELOG.md` yet, offer to create one with an `## [Unreleased]` section, in the language of the project's docs and commits; create it only after a yes.
8. Tell the user in one line that committing `.forge/profile.json` is their choice (teammates get the same checks), and that state, edit log, logs and everything in `.forge/work/` are already excluded from git (plans in the repository are committed by design).
