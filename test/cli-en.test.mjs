import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitRepo, runCli as run, write, writeProfile } from './helpers.mjs';

// English CLI output. Lines that come from other modules (profile, docs, changelog, ...) may be in any language,
// so these tests assert on the lines cli.mjs produces itself.
const runCli = (args, opts = {}) => run(args, { ...opts, env: { FORGE_LANG: 'en', ...opts.env } });
const CYRILLIC = /\p{Script=Cyrillic}/u;

const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n- New command\n\n## [0.1.0] - 2026-01-01\n\n### Added\n- First version\n';

function releaseRepo(changelog = CHANGELOG) {
  const dir = gitRepo();
  writeProfile(dir, { release: { version_files: ['package.json'] } });
  write(dir, 'CHANGELOG.md', changelog);
  write(dir, 'package.json', '{\n  "name": "x",\n  "version": "0.1.0"\n}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat: x');
  git(dir, 'tag', '-a', 'v0.1.0', '-m', 'release 0.1.0');
  return dir;
}

test('help is English', () => {
  for (const args of [[], ['help'], ['--help']]) {
    const r = runCli(args, { cwd: gitRepo() });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, CYRILLIC);
    assert.match(r.stdout, /forge init \[--yes\] \[--force\]\s+detect the stack/);
    assert.match(r.stdout, /forge release \[--check\] \[major\|minor\|patch\|x\.y\.z\]/);
  }
});

test('usage errors are English', () => {
  const dir = gitRepo();
  writeProfile(dir, {});
  const unknown = runCli(['frobnicate'], { cwd: dir });
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stderr, 'forge: unknown command "frobnicate". forge help\n');
  assert.equal(runCli(['route'], { cwd: dir }).stderr, 'forge: specify a role: forge route <role>\n');
  assert.equal(runCli(['mode', 'turbo'], { cwd: dir }).stderr, 'forge: mode must be one of: eco, normal, max\n');
  assert.equal(runCli(['state', 'set', 'tier'], { cwd: dir }).stderr, 'forge: expected pairs: forge state set <key> <value> [<key> <value>…]\n');
  assert.equal(runCli(['state', 'nope'], { cwd: dir }).stderr, 'forge: unknown state command nope\n');
  assert.equal(runCli(['docs', '--bogus'], { cwd: dir }).stderr, 'forge: unknown argument "--bogus". forge docs [--fix] [--json]\n');
  assert.match(runCli(['release', 'huge'], { cwd: dir }).stderr, /^forge: level must be major, minor, patch or a version x\.y\.z, got "huge"\. forge release /);
  assert.match(runCli(['release', '--date', '2026-02-31'], { cwd: dir }).stderr, /^forge: --date: a date in YYYY-MM-DD format is required, got "2026-02-31"\./);
  assert.match(runCli(['release', '--bogus'], { cwd: dir }).stderr, /^forge: unknown argument "--bogus"\./);
  assert.match(runCli(['release', 'minor', 'patch'], { cwd: dir }).stderr, /^forge: extra argument "patch"\./);
  assert.equal(runCli(['verify'], { cwd: gitRepo() }).stderr, 'forge: no profile — run forge init first\n');
});

test('init: preview and write messages are English', () => {
  const dir = gitRepo();
  write(dir, 'package.json', { scripts: { test: 'node -e ""' } });
  const preview = runCli(['init'], { cwd: dir });
  assert.match(preview.stdout, /^Stack: node \(npm\)$/m);
  assert.match(preview.stdout, /^The profile will be written to .*profile\.json:$/m);
  assert.match(preview.stdout, /^Write it: forge init --yes$/m);

  const written = runCli(['init', '--yes'], { cwd: dir });
  assert.match(written.stdout, /^Wrote .*profile\.json \(stack: node \(npm\)\)\.$/m);
  assert.match(written.stdout, /^Added to \.git\/info\/exclude: /m);

  const again = runCli(['init'], { cwd: dir });
  assert.match(again.stdout, /\(already exists — --force required\):$/m);
  assert.match(runCli(['init', '--yes'], { cwd: dir }).stderr, /^forge: .*profile\.json already exists\. Overwrite: forge init --yes --force\n$/);
});

test('mode, route and state messages are English', () => {
  const dir = gitRepo();
  writeProfile(dir, {});
  assert.match(runCli(['mode'], { cwd: dir }).stdout, /^Mode: normal$/m);
  assert.match(runCli(['mode', 'eco'], { cwd: dir }).stdout, /^Mode: eco$/m);
  assert.match(runCli(['route', '--table'], { cwd: dir }).stdout, /^Mode: eco$/m);
  assert.match(runCli(['state', 'reset'], { cwd: dir }).stdout, /^State reset \(mode and cursors kept\)\.$/m);
});

test('docs: ok line, --fix and doctor issue counts are English', () => {
  const dir = gitRepo();
  write(dir, 'AGENTS.md', '# Project\n');
  assert.equal(runCli(['docs', '--fix'], { cwd: dir }).stdout.split('\n')[0], 'created CLAUDE.md');
  assert.equal(runCli(['docs'], { cwd: dir }).stdout.trim(), '✓ Agent files are in order');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /^✓ Agent files are in order$/m);
  write(dir, 'AGENTS.md', '# Project\n[x](nope.md)\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /^! Agent files: 1 issue — forge docs$/m);
  write(dir, 'AGENTS.md', '# Project\n[x](nope.md) [y](nope2.md)\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /^! Agent files: 2 issues — forge docs$/m);
  write(dir, 'AGENTS.md', '# Project\n');
  write(dir, 'CLAUDE.md', '@AGENTS.md\n');
  const skipped = runCli(['docs', '--fix'], { cwd: dir });
  assert.doesNotMatch(skipped.stdout, CYRILLIC);
});

test('doctor: every line of a healthy project is English', () => {
  const dir = gitRepo();
  writeProfile(dir, { release: { version_files: ['package.json'] } });
  write(dir, 'AGENTS.md', '# Project\n');
  write(dir, 'CLAUDE.md', '@AGENTS.md\n');
  write(dir, 'CHANGELOG.md', CHANGELOG);
  write(dir, 'package.json', '{ "name": "x", "version": "0.1.0" }\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'x');
  git(dir, 'tag', '-a', 'v0.1.0', '-m', 'r');
  const r = runCli(['doctor'], { cwd: dir });
  const own = r.stdout.split('\n').filter((l) => l && !l.startsWith('    ') && !/^✗ not excluded/.test(l));
  for (const l of own) assert.doesNotMatch(l, CYRILLIC, l);
  assert.match(r.stdout, /^✓ Node \d/m);
  assert.match(r.stdout, /^✓ Plugin: /m);
  assert.match(r.stdout, /^✓ Project: /m);
  assert.match(r.stdout, /^✓ Routing table is valid$/m);
  assert.match(r.stdout, /^✓ Changelog is in order$/m);
  assert.match(runCli(['doctor'], { cwd: gitRepo() }).stdout, /^✗ No profile — forge init$/m);
});

test('release: not configured, check, preview and refusals are English', () => {
  const plain = gitRepo();
  writeProfile(plain, {});
  const none = runCli(['release'], { cwd: plain });
  assert.equal(none.code, 1);
  assert.equal(none.stdout.trim(), '✗ the release section is not configured in the profile — forge init will suggest it if the project is released');

  const dir = releaseRepo();
  assert.equal(runCli(['release', '--check'], { cwd: dir }).stdout.trim(), '✓ Changelog is in order');
  assert.match(runCli(['release', '--check', '--yes'], { cwd: dir }).stderr, /^forge: --check cannot be combined with --yes, a level or --date\n$/);
  assert.match(runCli(['release', '--yes'], { cwd: dir }).stderr, /^forge: specify a level or version: forge release <major\|minor\|patch\|x\.y\.z> --yes\n$/);

  const r = runCli(['release', '--date', '2026-03-04'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Level: minor \(/m);
  assert.match(r.stdout, /^Version: 0\.1\.0 → 0\.2\.0$/m);
  assert.match(r.stdout, /^Date: 2026-03-04$/m);
  assert.match(r.stdout, /^Files:$/m);
  assert.match(r.stdout, /^Tag: v0\.2\.0$/m);
  assert.match(r.stdout, /^Commit: chore\(release\): 0\.2\.0$/m);
  assert.match(r.stdout, /^Release: forge release minor --date 2026-03-04 --yes$/m);

  assert.match(runCli(['release', '0.0.5'], { cwd: dir }).stdout, /^✗ version 0\.0\.5 is not greater than current 0\.1\.0$/m);
  git(dir, 'tag', '-a', 'v0.2.0', '-m', 'x');
  assert.match(runCli(['release', 'minor'], { cwd: dir }).stdout, /^✗ tag v0\.2\.0 already exists$/m);

  const empty = releaseRepo('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n- First version\n');
  assert.match(runCli(['release'], { cwd: empty }).stdout, /^✗ \[Unreleased\] is empty — nothing to release$/m);

  write(dir, 'package.json', '{\n  "name": "x",\n  "version": "0.1.0",\n  "private": true\n}\n');
  assert.match(runCli(['release', 'patch', '--yes'], { cwd: dir }).stdout, /^✗ the working tree has uncommitted changes — commit or stash them$/m);
});

test('release --check: problem messages are English', () => {
  const dir = releaseRepo();
  write(dir, 'package.json', '{\n  "name": "x",\n  "version": "0.0.9"\n}\n');
  assert.match(runCli(['release', '--check'], { cwd: dir }).stdout, /^✗ package\.json: version is 0\.0\.9, current is 0\.1\.0 \[version-mismatch\]$/m);
  const missing = releaseRepo();
  git(missing, 'tag', '-d', 'v0.1.0');
  assert.match(runCli(['release', '--check'], { cwd: missing }).stdout, /^! version 0\.1\.0 is released, but tag v0\.1\.0 does not exist \[tag-missing\]$/m);
});

test('release --yes: success lines are English', () => {
  const dir = releaseRepo();
  const r = runCli(['release', 'minor', '--yes', '--date', '2026-03-04'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^✓ Released version 0\.2\.0$/m);
  assert.match(r.stdout, /^Commit: [0-9a-f]{7} chore\(release\): 0\.2\.0$/m);
  assert.match(r.stdout, /^Tag: v0\.2\.0$/m);
  assert.match(r.stdout, /^Push: git push origin main && git push origin v0\.2\.0$/m);
  assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## \[0\.2\.0\] - 2026-03-04/);
});

test('doctor: model environment lines are English', () => {
  const dir = gitRepo();
  writeProfile(dir, {});
  const clean = { ANTHROPIC_BASE_URL: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '', CLAUDE_CODE_SUBAGENT_MODEL: '', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '', CLAUDE_CODE_EFFORT_LEVEL: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_DEFAULT_OPUS_MODEL: '', ANTHROPIC_DEFAULT_FABLE_MODEL: '' };
  assert.match(runCli(['doctor'], { cwd: dir, env: clean }).stdout, /^✓ Models: Anthropic directly$/m);
  const r = runCli(['doctor'], { cwd: dir, env: { ...clean, CLAUDE_CODE_EFFORT_LEVEL: 'low' } });
  assert.match(r.stdout, /^! Models: CLAUDE_CODE_EFFORT_LEVEL=low is set/m);
});
