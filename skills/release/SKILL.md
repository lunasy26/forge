---
name: release
description: Use when the user asks to release, cut a version or publish a release of a project that has a CHANGELOG (the profile has a `release` section).
---

# forge:release

A release writes a version into the changelog, version files, a commit and a tag — and what follows (push, publishing, deployment) reaches other people and can't be taken back quietly. `forge release` does the mechanical part the same way every time; this skill adds the judgement around it and keeps the user in charge of every step that leaves the machine. Talk to the user in their language.

## Steps

1. **Check.** Run `forge release --check`. If it prints `✗` (a version file out of sync, a broken changelog), stop and fix that with the user first: a release on top of a mismatch ships the mismatch under a new number. Fixing version files is a change too: commit it (`chore: …`) with the user's OK before releasing. If it says the `release` section is not configured, tell the user `forge init` proposes it and stop.
2. **Read `[Unreleased]` as a user of the project would.** Entries should say what a user notices, not what the code did; internal noise (refactors, tests, tooling) doesn't belong, and each entry sits in the right section. Compare with `git log <last tag>..HEAD --oneline` for anything user-visible that is missing. Propose wording fixes as a list; apply them only with the user's OK — the changelog is their voice, and the text becomes permanent once tagged. Applied fixes leave the tree dirty, and `--yes` needs a clean one: with the user's OK commit them (`docs(changelog): …`) before step 4.
3. **Level.** Run `forge release --json` and show the user the suggested level, the reason and `current → next`. Whether a change is BREAKING is their judgement, not the tool's, so let them override the level (or give an exact `x.y.z`); re-run the preview with it.
4. **Release.** On the user's OK run `forge release <level or x.y.z> --yes`. It refuses a dirty tree (commit the fixes from steps 1–2 first, with the user's OK), a detached HEAD, a version file that differs from the current version, an empty `[Unreleased]`, a lower version and an existing tag — report the refusal as printed, don't work around it. It never pushes.
5. **Push.** Ask before pushing: a push publishes the commit and tag to everyone. Push the branch and the tag with the command `forge release` printed; never force. If the push is refused — by forge's own guard (a protected branch such as `main`) or by the remote — say so and offer what is left within the rules: pushing the tag alone, or the project's documented flow (a merge or pull request, a release branch). Never work around the guard or try another way to get the branch through.
6. **Project-specific steps.** Look in `AGENTS.md` and the docs (`docs/operations`, a «Выпуск» / «Release» section, CI workflows named in them) for what this project does after a tag: a GitHub release with the changelog section as notes, publishing images or packages, deployment, updating config in another repository. Offer these one by one, each with its exact command and only with the user's explicit approval — they are visible to others and often hard to undo. Never invent a step that isn't documented. If nothing is documented, offer only a GitHub release, and only when `gh` is installed and `origin` is a GitHub remote: `gh release create <tag> --verify-tag --notes-file <file with the version's section>`.

Finish with a short summary: version, tag, what was pushed and what was left undone.
