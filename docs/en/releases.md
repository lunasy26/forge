**English** · [Русский](../ru/releases.md)

← [README](../../README.md)

# Releases and CHANGELOG

Opt-in. forge keeps a project's changelog and version in step with each other: it checks the file, works out the next version from the entries, and does the mechanical part of a release the same way every time. Judgement stays with the model and you: what to write in the changelog, whether a change breaks users, what to push and publish.

The scheme is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/):

- new entries go under `## [Unreleased]`, in the sections `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security` (any other `###` section is allowed too);
- a release moves them to `## [x.y.z] — YYYY-MM-DD`, writes the version into the [version files](#version-files), makes a commit `chore(release): x.y.z` and an annotated tag `<tag_prefix>x.y.z`, and fixes the comparison links at the bottom of the changelog;
- the current version is the highest `[x.y.z]` heading of the changelog (by SemVer, not by position); without one, the latest version tag with the prefix; without that, `0.0.0`.

Without a `release` section in the [profile](profile.md#profile-fields) nothing of this is active: no reminder, no doctor line, and `forge release` prints `✗ раздел release в профиле не настроен — forge init предложит его, если проект выпускается` ("the release section is not configured in the profile — forge init proposes it if the project is released") and exits with 1.

**On this page:**

- [Turning it on](#turning-it-on)
- [The forge release command](#the-forge-release-command)
- [Choosing the level](#choosing-the-level)
- [What apply does and refuses](#what-apply-does-and-refuses)
- [Version files](#version-files)
- [Changelog checks](#changelog-checks)
- [Reminder about an empty Unreleased](#reminder-about-an-empty-unreleased)
- [Release flow in Claude](#release-flow-in-claude)
- [Limitations](#limitations)

## Turning it on

Either [`forge init`](profile.md#stack-detection) proposes the section, or you add it by hand; the empty object turns it on with all defaults:

```json
"release": {}
```

Fields, defaults and the schema are in [Profile fields](profile.md#profile-fields). `forge init` proposes the section when it finds at least one signal at the project root; every signal is printed in the notes as `Релизы включены: …` ("releases enabled: …"):

- `CHANGELOG.md` exists;
- there are git tags that are versions: `x.y.z` or `vx.y.z`;
- CI that publishes or releases: `docker push`, `docker/build-push-action`, `npm publish`, `twine upload`, `cargo publish`, `dotnet nuget push`, `gh release`, `goreleaser`; CI that starts on tags (`push: tags` in GitHub Actions, `CI_COMMIT_TAG` in GitLab); a manual `workflow_dispatch` with an input named like `publish`, `deploy` or `release`. Looked at: `.github/workflows/*.yml` and `.gitlab-ci.yml`; comment lines are ignored.

The proposed `version_files` are the root files `package.json`, `.claude-plugin/plugin.json`, `pyproject.toml`, `Cargo.toml`, `pom.xml` and `*.csproj` whose version is found and isn't `0.0.0`, plus every root `README*.md` with a `version-x.y.z-` badge (as `{ "path": …, "pattern": … }`). `tag_prefix` is `""` if there are version tags and none starts with `v`, otherwise `v`. With no signal there is no `release` section. As always, `forge init` only shows the proposal; `--yes` writes it.

## The forge release command

`forge release` has three modes:

| Command | What it does |
|---|---|
| `forge release --check [--json]` | Checks the changelog and the version files ([codes](#changelog-checks)); changes nothing |
| `forge release [major\|minor\|patch\|x.y.z] [--date YYYY-MM-DD] [--json]` | Preview: the level and why, `current → next`, every file with its change, the tag and the commit message; changes nothing, needs neither a clean tree nor a git repository |
| `forge release <major\|minor\|patch\|x.y.z> --yes [--date YYYY-MM-DD] [--json]` | [Applies](#what-apply-does-and-refuses) the release; the level or version is required, so a release is always a conscious choice |

A preview of a project at 1.4.2 with `Added` and `Fixed` entries under `[Unreleased]`:

```
$ forge release
Уровень: minor (есть Added)
Версия: 1.4.2 → 1.5.0
Дата: 2026-11-21
Файлы:
  CHANGELOG.md: [Unreleased] → [1.5.0] — 2026-11-21
  package.json: 1.4.2 → 1.5.0
Тег: v1.5.0
Коммит: chore(release): 1.5.0

Выпустить: forge release minor --yes
```

("Level: minor (there is Added)", "Version", "Date", "Files", "Tag", "Commit", "Release: …".) The date is today in local time; `--date` sets another one (it ends up in the last line too). With `--json` the preview is one line `{level, reason, current, next, tag, files, commit}`, where `files` is `[{path, from, to}]`.

Exit codes: 0 — a preview, a done release, a clean `--check` (warnings `!` don't change it); 1 — `--check` found an error, the release section is missing, or the command refused (the reason is printed as `✗ …` on stdout); 2 — a usage error (an unknown argument, a bad level or date, `--yes` without a level, `--check` with a level, `--yes` or `--date`), printed to stderr.

## Choosing the level

With no level given, forge suggests one from `[Unreleased]`; only sections that have entries count:

| Level | When |
|---|---|
| `major` | there is a `### Removed` section, or an entry in a standard section says `BREAKING` (any case) or «несовместим» ("incompatible") |
| `minor` | there is `### Added` or `### Changed` |
| `patch` | anything else: only `Fixed`, `Deprecated`, `Security`, or only custom sections |

- **Custom sections never raise the level.** A section outside the six standard ones (for instance «Обновление», "Upgrade") counts as `patch` material, and `BREAKING` in its text is not looked at: the standard sections carry the level.
- **Before 1.0, `major` becomes `minor`:** while the current major is 0, a would-be `major` is suggested as `minor`, and the reason says so: `раздел Removed (до 1.0 major заменяется на minor)` ("before 1.0 major is replaced by minor"). Only the suggestion is softened; an explicit `major` is honoured.
- The suggestion is a default, not a verdict: whether a change breaks users is your judgement. Pass `major`, `minor` or `patch` to override, or an exact `x.y.z`. The new version must be greater than the current one. An explicit `major` from 0.x gives 1.0.0.
- Pre-release versions are read but not produced: a pre-release current version is understood (`1.0.0-rc.1` sorts below `1.0.0`), and a level drops the suffix (`patch` on it gives `1.0.1`). A level never produces a pre-release; an exact version is written as given, but forge has no pre-release workflow.

## What apply does and refuses

`forge release <level> --yes` checks first and changes nothing if any check fails; it prints `✗ …` and exits with 1. It refuses when:

- the directory is not a git repository, or tracked files have uncommitted changes (untracked files don't count);
- the changelog is missing or unreadable, has no `[Unreleased]`, or `[Unreleased]` has no entries ("nothing to release");
- a version file can't be read (see [Version files](#version-files));
- the new version is not greater than the current one, or the tag already exists.

If it isn't on the default branch it only warns (`! выпуск не с ветки main (сейчас …)`, "release not from branch main"). The default branch is `origin/HEAD`; where origin is unknown, no warning is made.

Then it, in order:

1. rewrites the changelog: `[Unreleased]` stays as an empty heading, its entries go under `## [x.y.z] — date`, the comparison links at the bottom get the new version (everything else in the file stays byte for byte, line endings and BOM included);
2. writes the new version into every version file, replacing only the version text;
3. `git add` of those files only, and `git commit` with the message `chore(release): x.y.z`;
4. creates the annotated tag `<tag_prefix>x.y.z` (message `release x.y.z`).

If any step fails, forge puts the files back byte for byte, undoes its own commit and leaves no tag, then prints `Файлы возвращены в исходное состояние, тег не создан.` ("the files are restored, no tag created"). On success it prints:

```
✓ Выпущена версия 1.5.0
Коммит: 3f9a1c2 chore(release): 1.5.0
Тег: v1.5.0
Отправить: git push origin main && git push origin v1.5.0
```

("Released version", "Commit", "Tag", "Push".) **forge never pushes**: the last line is a hint for you or for [`/forge:release`](#release-flow-in-claude), which asks first. The [Bash guard](guards.md#guard-rules) still applies to the push you run. With `--json` the result is `{level, reason, current, next, tag, files, commit, sha, branch}`.

## Version files

`release.version_files` lists the files that carry the version. For a path string forge picks the handler by the file name:

| File | Where the version is |
|---|---|
| `*.json` (`package.json`, `.claude-plugin/plugin.json`) | the top-level `"version"` string |
| `pyproject.toml` | `version` in `[project]`, otherwise in `[tool.poetry]` |
| `Cargo.toml` | `version` in `[package]` |
| `pom.xml` | the project's own `<version>`, a direct child of `<project>` (not the parent's or a dependency's) |
| `*.csproj` | `<Version>` |
| anything else, or any file as `{ "path": "…", "pattern": "…" }` | `pattern` is a regular expression with exactly one capture group; the group is the version. Every match is replaced |

For example, the version badge of a README: `{ "path": "README.md", "pattern": "version-(\\d+\\.\\d+\\.\\d+)-" }`. A write replaces only the version characters, so formatting, key order and the rest of the file stay as they were. A file of an unknown type without `pattern`, a missing file or a pattern that finds nothing is an error (`version-file-unreadable`). An invalid `version_files` item is [reported by `forge doctor`](profile.md#broken-profile) and ignored.

Every version file must hold the current version, otherwise [`forge release --check`](#changelog-checks) reports `version-mismatch`: a release on top of a mismatch would ship it under a new number. With no `version_files` the version lives only in the changelog and git tags.

## Changelog checks

`forge release --check` prints lines `✗ <path>: <message> [<code>]` (error) and `! <path>: <message> [<code>]` (warning), or `✓ Журнал изменений в порядке` ("the changelog is in order"); `--json` prints an array of `{code, level, path, message}` on one line (`level` is `error` or `warn`; `path` is absent for `tag-missing`). It works only with a `release` section. [`forge doctor`](cli.md#commands) adds a line: `✓ Журнал изменений в порядке`, or `✗`/`!` `Журнал изменений: N замечаний — forge release --check` ("changelog: N issues"; `!` if all are warnings); it doesn't change `doctor`'s exit code.

| Code | Level | When |
|---|---|---|
| `changelog-missing` | error | The file `release.changelog` doesn't exist or can't be read |
| `no-unreleased` | error | No `## [Unreleased]` heading: nowhere to add new entries |
| `duplicate-version` | error | One version appears twice |
| `version-order` | error | A version stands above a higher one: versions must descend from top to bottom |
| `version-file-unreadable` | error | A version file is missing or has no version where the handler looks |
| `version-mismatch` | error | A version file's version differs from the current one |
| `bad-heading` | warning | A `## ` line that is neither `[Unreleased]` nor `[x.y.z] — YYYY-MM-DD` |
| `bad-date` | warning | A release date is not `YYYY-MM-DD` |
| `link-mismatch` | warning | The comparison links at the bottom are missing or don't compare the neighbouring versions. Checked only if the file has any such links |
| `tag-missing` | warning | The latest version of the changelog has no git tag `<tag_prefix><version>` (in a git repository) |

## Reminder about an empty Unreleased

With a `release` section and `release.remind` not `false`, the `Stop` hook looks at the edits of the turn. If code changed (any edited file that is not the changelog itself and doesn't match [`release.ignore`](profile.md#profile-fields), which by default covers tests, `docs/**` and Markdown) and `[Unreleased]` has no entries, the turn is blocked once with this reason:

```
forge: в этой задаче менялся код (…), а в CHANGELOG.md в [Unreleased] пусто. Если изменение заметно тому, кто пользуется проектом, добавь запись в нужный раздел; если нет — так и скажи и заверши работу.
```

("code changed in this task (…), and [Unreleased] in CHANGELOG.md is empty. If the change is noticeable to someone who uses the project, add an entry in the right section; if not, say so and finish.") The list of files is cut to about 100 characters with «… и ещё N» ("… and N more"). Adding any entry to `[Unreleased]` clears it: the reminder only looks at whether the section is empty.

- **One window.** The reminder reads the same window of edits as the [agent docs reminder](agent-docs.md#agent-docs-reminder): the journal after the `docs.offset` cursor, which is the one cursor of both. After every stop it moves to the end. If both reminders fire, Claude gets one `block` with both reasons, separated by a blank line; each part's error is logged and doesn't cost the other.
- **Once per branch.** What was already reminded about is kept in [`state.json`](state.md#state-file) (`release.reminded`, the newest 20 keys). On a feature branch the key is the branch name: one reminder per branch. On the default branch (`origin/HEAD`, or `main`/`master` where origin is unknown) and on a detached `HEAD` the key is `<branch>@<latest version tag>` (`@none` with no tags): one reminder per released version, so it comes back after the next release.
- **Order.** [Verification](hooks.md#verification-on-stop) comes first: a failed check (`block`) or a released session (three failures) means no reminder, and the cursor stays for the next passing check. Like the other reminder, it stays quiet without a profile and while background subagents run, and the first stop after an update only records the cursor.
- **When it stays quiet.** There is no `release` section, `release.remind` is `false`, the changelog file is missing (`forge release --check` reports that), `[Unreleased]` already has entries, only ignored files changed, or this branch was already reminded.

## Release flow in Claude

[`/forge:release`](skills.md#forgerelease) runs the release with the user. Mechanics (checks, level, files, commit, tag) belong to `forge release`; the skill adds judgement and keeps every step that leaves the machine behind your yes:

1. `forge release --check`. On `✗` it stops and the problem is fixed first.
2. Reads `[Unreleased]` as a user of the project would: entries should say what a user notices, each sits in the right section; compares with `git log <last tag>..HEAD`. Wording changes are proposed as a list and applied only with your OK: the text becomes permanent once tagged.
3. `forge release --json`: shows the suggested level, the reason and `current → next`; you can override the level or give `x.y.z`.
4. On your OK, `forge release <level> --yes`. A refusal is reported as printed, not worked around.
5. Asks before pushing; pushes the branch and the tag with the command that `forge release` printed, never with force. A refused push (a protected branch) is reported, not bypassed.
6. Looks in `AGENTS.md` and the docs for what the project does after a tag (a GitHub release with the changelog section as notes, publishing images or packages, deployment, updating config in another repository) and offers these steps one by one, each with its exact command and **only with your explicit approval**. It never invents a step that isn't documented; if nothing is documented, it offers only `gh release create <tag> --verify-tag --notes-file …`, and only if `gh` is installed and `origin` is on GitHub.

[`/forge:review`](skills.md#forgereview) tells the reviewer when the project has a `release` section, so a user-visible change in the diff without an `[Unreleased]` entry is a finding. [`/forge:init`](skills.md#forgeinit) mentions a proposed `release` section in its summary and offers to create a `CHANGELOG.md` with an `## [Unreleased]` heading if there is none.

## Limitations

- **Keep a Changelog only.** Parsing, checks and editing understand `## [Unreleased]` and `## [x.y.z] — date` with `###` sections, and nothing else; another changelog format is reported by `forge release --check` (`bad-heading`, `no-unreleased`) and can't be released.
- **One changelog and one version per project root.** There is a single `release.changelog` and a single current version; a monorepo with separate versions per package is not supported.
- **Pre-release versions are read, not produced.** `1.0.0-rc.1` in the changelog, a tag or a version file is understood and sorts below `1.0.0`, but a level (`major`, `minor`, `patch`) always gives a plain `x.y.z`; there are no `rc` or build-metadata workflows.
- **The default branch** comes from `origin/HEAD`; where origin or its `HEAD` is unknown, `main` and `master` are taken for the reminder's tag-keyed memory, and the release-from-another-branch warning is not made.
- The release reminder, like the agent docs one, sees only [edits made with edit tools](hooks.md#limitations) and doesn't judge what counts as user-visible beyond `release.ignore`: that is for Claude and for [`/forge:release`](#release-flow-in-claude).
- `forge release --yes` commits only the changelog and the version files and stops before the push; publishing and deployment are done by CI or by steps you approve.
