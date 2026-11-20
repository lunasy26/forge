---
name: docs
description: Use to create, migrate or split the project's AGENTS.md/CLAUDE.md files, or when forge docs reports problems.
---

# forge:docs

`AGENTS.md` is the project memory every coding agent reads; `CLAUDE.md` imports it with an `@AGENTS.md` line and keeps only what is specific to Claude Code. One source means Codex, Cursor and Claude Code follow the same rules and an edit lands in one place. `forge docs` checks this layout and creates the one-line `CLAUDE.md` links; writing the content is this skill's job. What belongs in which file, and why, is in [guide.md](guide.md) next to this file — read it before step 3.

Text the user already wrote is the most valuable input: those rules were usually learned the hard way. Move it, don't rewrite it, and never drop a line without the user's agreement.

## Dispatching a role

Whenever this skill says "dispatch <role>": run `forge route <role>`, then call the agent named in `agent=` with `model` and `effort` set to the printed values. If `agent=main`, do that part yourself.

## Steps

1. **Check.** Run `forge docs --json`: an array of `{code, level, path, message, fixable}`. Also look for other tools' rule files: `ls -d .cursorrules .cursor/rules .windsurfrules .clinerules .github/copilot-instructions.md GEMINI.md 2>/dev/null`. Pick the mode — more than one can apply (migrate, then split the result):
   - **create** — `missing-root`, and there is no rule text anywhere to move.
   - **migrate** — rule text lives outside `AGENTS.md`: `missing-root` while the root `CLAUDE.md` has more than the `@AGENTS.md` line, `claude-only`, `fat-claude`, `no-import` on a non-empty `CLAUDE.md`, or other tools' rule files.
   - **split** — `too-long`.
   - **repair** — every reported issue is `fixable` or is `unlisted`, `broken-link` or `verify-undocumented`. Run `forge docs --fix` for the fixable ones (it only creates `@AGENTS.md` links). For the others propose the exact line to add or change (a routing-table row, a corrected link, the command in the Commands section) and write it after the user's OK. Then run `forge docs` and stop — there is nothing to draft.
   - Empty array and no specific request from the user → say the files are in order and stop. `incomplete-scan` → tell the user some files may have been missed.

2. **Gather context.**
   - Read in full, yourself, every file whose text will move: existing `AGENTS.md`/`CLAUDE.md` files and the other tools' rule files. You need their exact wording, not a summary.
   - Language: the one the project's docs and commits use (README, `git log --oneline -20`). If they disagree or there is nothing to go by, ask the user.
   - For **create**, and for **split** when the area boundaries aren't obvious: dispatch `scout`, one per area (an app, a package with its own manifest, a subsystem; a small project is one area), in parallel. Ask each for conclusions in at most ~40 lines: purpose; stack and its manifest; commands with exact names as defined in manifests, Makefile or CI (build, test, a single test, lint, run); a directory map, one line per directory; non-obvious rules and invariants from configs, CI, CONTRIBUTING, `docs/` and the code; gotchas; what the README already covers, so the files don't repeat it. Scouts can't run commands, so commands are "as defined", not "verified".
   - For **migrate** and **split**, if the moved text names commands or paths, a scout can check they still exist. Stale lines are flagged to the user in step 4, never silently fixed or dropped.

3. **Structure.** Lay out files and sections by `guide.md`. Root: orientation, directory map, common commands, cross-cutting rules, git flow, and a routing table "change in X → `X/AGENTS.md`". A nested `AGENTS.md` only for an area with its own stack and manifest, a monorepo package, or a subsystem whose rules crowd the root — never one per directory, because every extra file is one more place to forget to update.

4. **Draft, then ask.** Before writing anything, show the user:
   - each file to write, its sections with one line each, and a rough line count;
   - for migrate and split, a move map: source file and section → destination file and section, moved verbatim;
   - what stays in `CLAUDE.md` as Claude-Code-specific, and which text is new (written by you rather than moved);
   - lines that already exist in the destination (removed from the source, not copied twice);
   - stale or contradicting lines you found — kept as they are unless the user says otherwise;
   - for other tools' rule files: keep them, delete them, or leave a one-line pointer to `AGENTS.md` — the user's choice, since that tool may still read them.

   Write only after the user's OK. These files steer every future session, and the user knows rules the code doesn't show.

5. **Write and check.**
   - Copy every existing file you will edit, trim or delete (agent files and other tools' rule files) to `.forge/work/docs-backup/`, keeping its path relative to the project root (a `mktemp -d` directory instead if the project has no `.forge/`), and tell the user where. Git can't restore text that was never committed.
   - Write the destinations first, then trim the sources. Moving means verbatim: you may change heading levels and add headings, orientation lines and routing rows, but don't reword, condense or "improve" the user's lines.
   - Each `CLAUDE.md` that stays: `@AGENTS.md` as the first line, then only Claude-Code-specific text (see `guide.md`). Nothing specific left → just the `@AGENTS.md` line.
   - Prove nothing was lost. For each backup run `cat <every file you wrote or trimmed> | grep -Fvxf - <backup>`: it prints lines of the original that appear in none of the new files. Each printed line must be put back, or listed in your report as dropped with the user's agreement. Lines that only changed heading level show up too — confirm them by eye.
   - Run `forge docs --fix` (creates the `CLAUDE.md` link next to each new nested `AGENTS.md`), then `forge docs`: no ✗ lines. Fix warnings about the files you wrote (`unlisted` → a routing-table row, `broken-link` → the path).
   - Report: files written with line counts, what moved where, any dropped lines and who agreed, where the backups are, and warnings still open.
