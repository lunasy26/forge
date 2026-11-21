**English** · [Русский](../ru/development.md)

← [README](../../README.md)

# Development

How the forge repository is laid out and how to change it. Rules for anyone changing forge (agents included) are in [AGENTS.md](../../AGENTS.md); the specification and design decisions are in [docs/spec.md](../spec.md).

## Repository layout

```
.claude-plugin/     plugin.json (manifest, version), marketplace.json (the forge-dev marketplace)
hooks/              hooks.json and thin wrappers over lib/: JSON on stdin → JSON on stdout
lib/                all the logic: guards, shell, glob, profile, state, edits, verify, docs, changelog, release, route, detect, cli, git, paths, settings, util
config/             routing.json (roles and the mode table), profile.schema.json
agents/             scout, implementer, reviewer, debugger
skills/             init, mode, plan, execute, review, docs, release
bin/forge           CLI entry point
test/               node:test; helpers.mjs — temporary repositories, running hooks and the CLI
docs/               spec.md — specification and design decisions; en/, ru/ — this documentation
.github/workflows/  test.yml: npm test on Node 20, 22, 24
```

The plugin layout follows the Claude Code [plugins reference](https://code.claude.com/docs/en/plugins-reference).

## Running tests

```bash
npm test                                                          # all tests: node test/run.mjs
node test/run.mjs test/guards.test.mjs                            # one file
node test/run.mjs --test-name-pattern "force" test/guards.test.mjs  # tests by name
```

`test/run.mjs` is a portable wrapper over `node --test` (works on Windows too: no shell glob or env prefix): it collects `test/*.test.mjs` itself, passes other options through and always sets `FORGE_LANG=ru` (an exported value is ignored). So most tests assert the Russian messages. The English ones live in `test/*-en.test.mjs` (`cli-en`, `core-en`, `guards-en`, `hooks-en`) and pin the language themselves. Language resolution and the catalog parity test are in `test/i18n.test.mjs`.

## Testing hooks

`runHookScript(name, input, { projectDir })` from `test/helpers.mjs` runs `node hooks/<name>.mjs`, feeds the event JSON on stdin, sets `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and an isolated `CLAUDE_CONFIG_DIR` (the developer's settings are not read) and returns the exit code, stdout and the parsed JSON. Fixture projects: `gitRepo(branch)` (a temporary repository without commit signing and git hooks), `writeProfile`, `write`; the CLI: `runCli(args, { cwd })`.

## Adding a guard rule

1. Logic goes to `lib/guards.mjs` (`checkPush`, `checkCommit`, `checkGit`, `checkRm`, or a new branch by command name in `checkBash`); the verdict is `deny(…)` or `ask(…)` with a reason starting with `forge:`, written in both languages (see [Adding a message](#adding-a-message)). Command parsing lives in `lib/shell.mjs`.
2. Tests go to `test/guards.test.mjs`: the forbidden spellings and similar allowed ones; parsing changes also go to `test/glob-shell.test.mjs`.
3. Update the [rules table](guards.md#guard-rules) here and in [its Russian counterpart](../ru/guards.md#правила-охраны), and add an entry to `CHANGELOG.md`.

## Adding a message

Everything the user sees goes through a catalog; no user-facing string is written inline in code.

1. In the module, next to the code that uses it, there is a catalog: `const MSG = defineCatalog({ en: { … }, ru: { … } })` (`defineCatalog` from `lib/i18n.mjs`). Add the key to both languages. A message is a string with `{name}` placeholders or, when it has to build text (plurals, lists), a function of the parameters.
2. Use it as `t(MSG, 'key', { name: value })`. The catalog falls back to English for a missing key, but a key absent from `en` throws.
3. Render lazily: call `t` where the message is produced, not at module load, because the language is chosen at runtime by `initLang` (in each hook and in the CLI). Don't keep ready-made strings in top-level constants.
4. `test/i18n.test.mjs` imports every module in `lib/` and checks that each registered catalog has the same keys, value types and `{placeholders}` in `en` and `ru`; a missing translation fails `npm test`.
5. Tests of the message text: Russian in the usual files (`npm test` runs with `FORGE_LANG=ru`), English in `test/*-en.test.mjs`.
6. Logs, code comments, skills and agents stay in English and are not translated.

## Adding a role

1. `config/routing.json`: `roles.<role>.agent` (an existing agent, or `null` for the main session) and the role's row in each of `eco`, `normal`, `max`.
2. `config/profile.schema.json`: the role in `$defs.routingMode.properties` — it has `additionalProperties: false`, so without this an override fails the schema.
3. If the role is on the [ladder](routing.md#retry-ladder) — [invariants](routing.md#invariants) in `checkTable` (`lib/route.mjs`) and tests in `test/route-profile.test.mjs`: the built-in table passes them, violating overrides are rejected.
4. A new agent — `agents/<name>.md` with `model`/`effort` equal to the `normal` row, and its name in the frontmatter test list in `test/route-profile.test.mjs`.
5. The skills that call the role; the [routing page](routing.md) in both languages and `CHANGELOG.md`.
