---
name: init
description: Set up forge in the current project — detect the stack and create .forge/profile.json with verification commands, protected branches and files. Use when the user runs /forge:init or asks to set up forge for a project.
disable-model-invocation: true
---

# forge:init

1. Run `forge init`. It prints the detected stack, the proposed profile and notes, without writing anything.
2. Show the user a short summary: stack, verification steps and what runs when you finish a turn (`verify.on_stop`), protected branches, risky paths. Ask only about what the notes flag as unknown (for example an Xcode test command) or what looks wrong for this project.
3. Write the profile with `forge init --yes`. If the user wanted changes, edit `.forge/profile.json` afterwards — the schema next to it gives field descriptions.
4. Run `forge doctor` and report any ✗ lines.
5. Run `forge docs` to see whether the project's agent files (`AGENTS.md`, `CLAUDE.md`) are set up — every session starts from them. If it reports `missing-root`, offer `/forge:docs` in one line: it drafts the files from the project and writes them only after the user's OK. Otherwise, if it reports `missing-shim`, offer `forge docs --fix`: it only creates one-line `CLAUDE.md` files with `@AGENTS.md`, so Claude Code reads the existing `AGENTS.md`. Run neither without a yes; leave other findings to `forge docs`.
6. Tell the user in one line that committing `.forge/profile.json` is their choice (teammates get the same checks), and that state, edit log, work artifacts and logs are already excluded from git.
