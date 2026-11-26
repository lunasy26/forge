---
name: finish
description: Use when a branch is done and reviewed and the user wants to wrap it up — merge it, open a pull request, or "finish the branch".
---

# forge:finish

Finishing a branch is where work leaves the sandbox: a merge changes the branch everyone builds on, a push or a pull request reaches other people, a deleted branch is gone. `forge finish` gathers the facts the same way every time (base, clean tree, a full check of the branch, the changelog) and prints the exact commands for the project's flow; this skill adds judgement and keeps the user in charge of every step that changes a shared branch or leaves the machine. Talk to the user in their language.

The CLI never merges, pushes or deletes anything itself: you run its commands with Bash, so forge's guards see each of them.

## Steps

1. **Stage.** If there is an active task (`forge state get task`), run `forge state set stage finish`. If the project has a remote, run `git fetch` first. Fetch changes no local branch: it only updates `origin/<base>`, which lets `forge finish` notice that the local base itself is out of date (`base-stale`).
2. **Check.** Run `forge finish --json` (add `--base <branch>` only if the user names one). It runs the full check over the files of the branch and records it like `forge verify`.
3. **Fix what is `fail`.** Report each one as printed, then:
   - `dirty` — show `git status --short` and offer to commit (a conventional message from the diff) only with the user's OK; never stash or discard their changes.
   - `verify-failed` — this is a bug to fix, not a step to skip: fix it like any failing check, then re-run step 2.
   - `on-base`, `no-commits`, `detached`, `no-base` — nothing to finish as things stand; say why and stop.
4. **Weigh the warnings.**
   - `base-stale` — the local base lacks commits its upstream has, so `behind` was measured against a stale base and the push of the base would be rejected. With the user's OK, update the local base as the warning says (`git pull --ff-only` on the base: `git -C <path> pull --ff-only` where it is checked out in another worktree, or `git fetch origin <base>:<base>` when it is checked out nowhere), then re-run step 2 — `behind` will then show what really needs bringing in.
   - `behind` — the base moved, so the merge result was never tested. Offer `git rebase <base>` when the branch was never pushed (rebase rewrites its commits), otherwise `git merge <base>`; with the user's OK, then re-run step 2.
   - `untracked` — ask whether these files belong in the change; a forgotten new file is the classic broken merge.
   - `unreleased-empty` — user-visible changes without a changelog entry. Propose an entry under `[Unreleased]` in the user's words, commit it with their OK, re-run step 2.
   - `verify-no-shell`, `no-verify-steps`, `verify-skipped` — say plainly that the branch was not checked.
5. **Flow.** Use `flow` from the result (`git.flow` in the profile). If it is `null` (`flow-unset`), show both lists of steps and ask which way this project works; offer to save the answer as `git.flow` in `.forge/profile.json` so the question doesn't come back.
6. **Integrate, one consent per kind of step.** Show the steps for the chosen flow with their notes, then ask before each group and run the commands exactly as printed:
   - **merge**: the merge into the base (local), the push of the base, deleting the remote branch, then deleting the local branch — in the printed order (`git branch -d` refuses an unmerged branch — never switch to `-D`). If the push of the base is refused, stop there: the remote branch is then the only published copy of the work, so don't delete it.
   - **pr**: the push of the branch, then the pull request. Draft the title and body from `spec.md` (`forge state get artifacts.spec`) or the commits, show them, and pass them as `--title`/`--body` instead of `--fill` if the user prefers.
   Notes matter: `base-protected` means forge's guard will refuse the push of the base — the merge stays local, or the user picks the pr flow; `branch-in-worktree` means the branch can only be deleted after this worktree is removed — say so, don't remove the worktree yourself. If any command is refused, by a guard or by git, report it and offer what is left within the rules; never work around a guard, never force.
7. **Close the task.** Once the branch is merged or the pull request is open, run `forge state reset`. If `.forge/work/<slug>/` holds decisions worth keeping, offer to move them into the project's docs before the files are forgotten; don't delete them.

Finish with a short summary: what was merged or opened (with the PR link), what was pushed and deleted, and what was left undone.
