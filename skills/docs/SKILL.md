---
name: docs
description: Use to create, migrate or split the project's AGENTS.md/CLAUDE.md files, or when forge docs reports problems.
---

# forge:docs

`AGENTS.md` is the project memory every coding agent reads; `CLAUDE.md` imports it with an `@AGENTS.md` line and keeps only what is specific to Claude Code. One source means Codex, Cursor and Claude Code follow the same rules and an edit lands in one place. `forge docs` checks this layout and creates the one-line `CLAUDE.md` links; writing the content is this skill's job. What belongs in which file, and why, is in [guide.md](guide.md) next to this file — read it before step 3.

Text the user already wrote is the most valuable input: those rules were usually learned the hard way. Move it, don't rewrite it, and never delete a line the user hasn't explicitly agreed to delete.

## Dispatching a role

Whenever this skill says "dispatch <role>": run `forge route <role>`, then call the agent named in `agent=` with `model` and `effort` set to the printed values. If `agent=main`, do that part yourself.

## Steps

1. **Check.** Run `forge docs --json`: an array of `{code, level, path, message, fixable}`. Ignore `incomplete-scan` when choosing the mode; just tell the user some files may have been missed. Pick the mode — more than one can apply (migrate, then split the result):
   - **create** — `missing-root`, and there is no rule text anywhere to move.
   - **migrate** — rule text lives outside `AGENTS.md`: `missing-root` while the root `CLAUDE.md` has more than the `@AGENTS.md` line, `claude-only`, `fat-claude`, or `no-import` on a non-empty `CLAUDE.md`. Other tools' rule files are a source only while there is no root `AGENTS.md` yet, or when the user asks: find them with `ls -d .cursorrules .cursor/rules .windsurfrules .clinerules .github/copilot-instructions.md GEMINI.md 2>/dev/null`. Once the files are set up, a kept rule file (the user's choice) or one whose text is already in `AGENTS.md` is not a reason to migrate again.
   - **split** — `too-long`.
   - **repair** — every reported issue is `fixable` or is `unlisted`, `broken-link` or `verify-undocumented`. Ask the user once, listing what you'd do: `forge docs --fix` for the fixable ones (it creates one-line `@AGENTS.md` files and nothing else), and the exact line to add or change for the others (a routing-table row, a corrected link, the command in the Commands section). After the yes, apply them, run `forge docs` and stop — there is nothing to draft. If `--fix` prints `пропущен <path>: <reason>`, pass the reason on to the user; don't write that file yourself.
   - Nothing left (empty list, or only `incomplete-scan`) and no specific request from the user → say the files are in order and stop.

2. **Gather context.**
   - Read in full, yourself, every file whose text will move: existing `AGENTS.md`/`CLAUDE.md` files and the other tools' rule files. You need their exact wording, not a summary.
   - Language: the one the project's docs and commits use (README, `git log --oneline -20`). If they disagree or there is nothing to go by, ask the user.
   - Dispatch `scout`, one per area (an app, a package with its own manifest, a subsystem, a folder that is its own git repository; a small project is one area), in parallel — for **create**, for **split** when the area boundaries aren't obvious, and for **migrate** when the root will need sections the moved text lacks (directory map, commands): fill those from facts, don't guess. Ask each scout for conclusions in at most ~40 lines: purpose; stack and its manifest; commands with exact names as defined in manifests, Makefile or CI (build, test, a single test, lint, run); a directory map, one line per directory; non-obvious rules and invariants from configs, CI, CONTRIBUTING, `docs/` and the code; gotchas; what the README already covers, so the files don't repeat it. Scouts can't run commands, so commands are "as defined", not "verified".
   - For **migrate** and **split**, if the moved text names commands or paths, a scout can check they still exist. Stale lines are flagged to the user in step 4, never silently fixed or dropped.

3. **Structure.** Lay out files and sections by `guide.md`. Root: orientation, directory map, common commands, cross-cutting rules, git flow, and a routing table "change in X → `X/AGENTS.md`". A nested `AGENTS.md` only for an area with its own stack and manifest, a monorepo package, a separate git repository, or a subsystem whose rules crowd the root — never one per directory, because every extra file is one more place to forget to update.
   - Scoped rules from other tools (`.cursor/rules/*.mdc` with `globs`/`alwaysApply`, files in `.clinerules/`) go to the nested file of the area they cover, or carry their scope in words ("When editing `*.sql`: …"). Don't copy their frontmatter into `AGENTS.md`.

4. **Draft, then ask.** Before writing anything, show the user:
   - each file to write, its sections with one line each, and a rough line count; a file that lands in another git repository is marked as such (it gets committed there);
   - for migrate and split, a move map: source file and section → destination file and section, moved verbatim;
   - what stays in `CLAUDE.md` as Claude-Code-specific, and which text is new (written by you rather than moved);
   - lines that already exist in the destination (removed from the source, not copied twice);
   - stale or contradicting lines you found — kept as they are unless the user says otherwise;
   - lines you propose to delete, quoted or as exact source line ranges, each with a reason. Each needs the user's explicit yes; agreeing to the draft as a whole doesn't count. The default for existing text is moving it — to a nested file, or to `docs/` with a routing row — not deleting it;
   - for other tools' rule files: keep them, delete them, or leave a one-line pointer to `AGENTS.md` — the user's choice, since that tool may still read them.

   Write only after the user's OK. These files steer every future session, and the user knows rules the code doesn't show.

5. **Write and check.**
   - Back up every existing file you will edit, trim or delete (agent files and other tools' rule files), from the project root. The backup must stay out of git and out of `forge docs`, so it goes to `.forge/work/` only when that is ignored:

     ```sh
     ts=$(date +%Y%m%d-%H%M%S)
     if ! git rev-parse --git-dir >/dev/null 2>&1 || git check-ignore -q .forge/work/; then b=.forge/work/docs-backup/$ts
     else b=$(git rev-parse --git-common-dir)/forge-docs-backup/$ts; fi
     for f in <files>; do mkdir -p "$b/$(dirname "$f")" && cp -R "$f" "$b/$f"; done; echo "$b"
     ```

     Tell the user the printed path. Git can't restore text that was never committed.
   - Write the destinations first, then trim the sources. Moving means verbatim: you may change heading levels and add headings, orientation lines and routing rows, but don't reword, condense or "improve" the user's lines.
   - Each `CLAUDE.md` that stays: `@AGENTS.md` as the first line, then only Claude-Code-specific text (see `guide.md`). Nothing specific left → just the `@AGENTS.md` line.
   - Prove nothing was lost. For each backed-up file run
     `for f in <every file you wrote or trimmed>; do cat "$f"; echo; done | tr -d '\r' | grep -Fvxf - <(tr -d '\r' < <backup file>) | grep -v '^[[:space:]]*$'`
     It prints the original's lines that appear in none of the new files. Each one must be put back, or be a deletion the user explicitly agreed to in step 4. Lines whose heading level or indentation changed, and the frontmatter of scoped rule files, show up too — confirm them by eye.
   - Run `forge docs --fix` (creates the `CLAUDE.md` link next to each new nested `AGENTS.md`), then `forge docs`: no ✗ lines. Fix warnings about the files you wrote (`unlisted` → a routing-table row, `broken-link` → the path). A nested file inside another git repository isn't seen from the parent: run `forge docs` there too.
   - Report: files written with line counts, what moved where, deleted lines and the user's agreement for each, where the backups are, and warnings still open.
