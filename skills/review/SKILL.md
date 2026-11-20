---
name: review
description: Use to review a finished change before it is committed or merged — after forge:execute, for any risky (tier 3) work, or when the user asks for a review of the current changes.
---

# forge:review

A reviewer at least as strong as the implementer catches what the implementer couldn't see. Findings that don't survive a second look waste the user's time, so verify before presenting.

## Steps

1. **Scope.** Find the base: `git merge-base HEAD <protected branch>` (usually `main` or `master` — see `git.protected_branches` in the profile). The change is `git diff <base>` plus untracked files from `git status --short`. Check its size with `git diff --stat <base>`.
2. **Dispatch the reviewer.** Run `forge route reviewer` and call the agent named in `agent=` with the printed `model` and `effort`. Give it the base ref and the intent: `spec.md` from `forge state get artifacts.spec` if there is an active task, otherwise the user's description of the change. For diffs over ~800 lines, split by area and run reviewers in parallel.
3. **Verify findings.** For every blocker and major, check the cited code yourself or with a `scout`. Drop anything that doesn't hold up.
4. **Record.** Write the confirmed findings to `.forge/work/<slug>/review.md` (or `.forge/work/review.md` without an active task) and run `forge state set stage review`.
5. **Present** the findings by severity and ask the user which to fix. Fixes go through implementer tasks; afterwards re-review only the areas that changed.
