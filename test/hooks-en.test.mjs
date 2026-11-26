import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkChangelog, parseChangelog, releaseChangelog, suggestBump } from '../lib/changelog.mjs';
import { checkDocs, fitList } from '../lib/docs.mjs';
import { getLang, setLang } from '../lib/i18n.mjs';
import { readVersion } from '../lib/release.mjs';
import { git, gitRepo, runHookScript, tempDir, write, writeProfile } from './helpers.mjs';

const CYRILLIC = /[Ѐ-ӿ]/;
const EN = { FORGE_LANG: 'en' };
/** No FORGE_LANG and no locale: the language must come from the transcript. */
const AUTO = { FORGE_LANG: undefined, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: undefined };

const PKG = { name: 'x', version: '1.0.0', scripts: { test: 'node --test' } };
const CHANGELOG_EMPTY = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- first\n';

/** Run fn with English messages in this process, then restore whatever the test run started with. */
function inEnglish(fn) {
  const before = getLang();
  setLang('en');
  try {
    fn();
  } finally {
    setLang(before);
  }
}

function transcript(...texts) {
  const lines = texts.map((text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
  return write(tempDir(), 'transcript.jsonl', `${lines.join('\n')}\n`);
}

function projectWithCheck({ lint = false } = {}) {
  const dir = gitRepo('feature/x');
  write(dir, 'status.txt', 'fail');
  write(dir, 'check.mjs', "import { readFileSync } from 'node:fs';\nconst s = readFileSync('status.txt','utf8').trim();\nif (s !== 'ok') { console.error('check failed: ' + s); process.exit(1); }\n");
  write(dir, 'lint.mjs', "import { readFileSync } from 'node:fs';\nfor (const f of process.argv.slice(2)) if (readFileSync(f,'utf8').includes('BAD')) { console.error(f + ': BAD found'); process.exit(1); }\n");
  const commands = { test: 'node check.mjs' };
  if (lint) commands.lint = 'node lint.mjs {files}';
  writeProfile(dir, { commands, verify: { steps: ['test'], on_stop: 'full' } });
  return dir;
}

const edit = (dir, rel, content = 'x', env = {}) => {
  const file = write(dir, rel, content);
  return runHookScript('post-edit', { cwd: dir, tool_name: 'Write', tool_input: { file_path: file } }, { projectDir: dir, env });
};
const stop = (dir, extra = {}, env = EN) =>
  runHookScript('stop', { cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, ...extra }, { projectDir: dir, env });
const state = (dir) => JSON.parse(readFileSync(join(dir, '.forge', 'state.json'), 'utf8'));

test('stop in English: failing check, debugger hint, give-up', () => {
  const dir = projectWithCheck();
  edit(dir, 'a.ts', '1', EN);
  const first = stop(dir);
  assert.equal(first.json.decision, 'block');
  assert.match(first.json.reason, /^forge: the check before finishing failed\./);
  assert.match(first.json.reason, /check failed: fail/);
  assert.doesNotMatch(first.json.reason, CYRILLIC);

  edit(dir, 'a.ts', '2', EN);
  const second = stop(dir, { stop_hook_active: true });
  assert.match(second.json.reason, /failure #2 in a row/);
  assert.match(second.json.reason, /debugger/);
  assert.doesNotMatch(second.json.reason, CYRILLIC);

  edit(dir, 'a.ts', '3', EN);
  const third = stop(dir, { stop_hook_active: true });
  assert.equal(third.json.decision, undefined);
  assert.match(third.json.systemMessage, /failed 3 times in a row/);
  assert.doesNotMatch(third.json.systemMessage, CYRILLIC);
});

test('stop in English: the user is told once about the last failed check', () => {
  const dir = projectWithCheck();
  edit(dir, 'a.ts', '1', EN);
  stop(dir);
  const again = stop(dir, { stop_hook_active: true });
  assert.match(again.json.systemMessage, /^forge: the last check failed \(/);
  assert.doesNotMatch(again.json.systemMessage, CYRILLIC);
});

test('stop in English: agent-docs and release reminders', () => {
  const dir = gitRepo('feature/x');
  write(dir, 'AGENTS.md', '# Agents\n');
  write(dir, 'package.json', PKG);
  write(dir, 'CHANGELOG.md', CHANGELOG_EMPTY);
  write(dir, 'lib/a.mjs', 'export {}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  writeProfile(dir, { verify: { on_stop: 'off' }, release: {} });
  assert.equal(stop(dir).stdout, '', 'first stop only sets the cursor');
  edit(dir, 'package.json', { ...PKG, scripts: { test: 'node --test', build: 'tsc' } }, EN);
  edit(dir, 'lib/a.mjs', 'export const a = 1;\n', EN);
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  const [docs, release] = r.json.reason.split('\n\n');
  assert.match(docs, /^forge: commands or structure changed in this task: package\.json \(scripts\)\. Check AGENTS\.md for anything out of date: commands, directory map, rules\. /);
  assert.match(docs, /say so and finish\.$/);
  assert.match(release, /^forge: code changed in this task \(.*lib\/a\.mjs.*\), but \[Unreleased\] in CHANGELOG\.md is empty\./);
  assert.ok(docs.length <= 600 && release.length <= 400, `lengths ${docs.length}/${release.length}`);
  assert.doesNotMatch(r.json.reason, CYRILLIC);
});

test('session-start in English stays under 600 chars', () => {
  const noProfile = gitRepo();
  const hint = runHookScript('session-start', { cwd: noProfile, source: 'startup' }, { projectDir: noProfile, env: EN });
  assert.match(hint.json.hookSpecificOutput.additionalContext, /no profile in this project.*\/forge:init/);
  assert.doesNotMatch(hint.json.hookSpecificOutput.additionalContext, CYRILLIC);

  const dir = projectWithCheck();
  write(dir, '.forge/state.json', { version: 1, tier: 2, task: { slug: 'add-a-very-long-feature-name' }, stage: 'implement', artifacts: { plan: '.forge/work/add-a-very-long-feature-name/plan.md' }, verify: { ok: false, summary: 'test failed' } });
  const r = runHookScript('session-start', { cwd: dir, source: 'resume' }, { projectDir: dir, env: EN });
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^forge: mode normal, tier T/);
  assert.match(ctx, /Active task: add-a-very-long-feature-name, stage implement/);
  assert.match(ctx, /Last check failed: test failed/);
  assert.doesNotMatch(ctx, CYRILLIC);
  assert.ok(ctx.length <= 600, `length ${ctx.length}`);
});

test('session-start in English: where to pick up after compaction', () => {
  const dir = projectWithCheck();
  write(dir, '.forge/work/x/plan.md', '- [x] T1 Parse the plan\n- [ ] T2 Wire the hook\n  depends: T1\n');
  write(dir, '.forge/state.json', { version: 1, tier: 2, stage: 'execute', task: { slug: 'x' }, artifacts: { plan: '.forge/work/x/plan.md' } });
  const ctx = runHookScript('session-start', { cwd: dir, source: 'compact' }, { projectDir: dir, env: EN }).json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.split('\n').includes('Where to pick up: next task T2 "Wire the hook" (1/2 done); continue with forge:execute.'), ctx);
  assert.doesNotMatch(ctx, CYRILLIC);

  write(dir, '.forge/state.json', { version: 1, tier: 2, stage: 'plan', task: { slug: 'x' }, artifacts: {} });
  const plan = runHookScript('session-start', { cwd: dir, source: 'resume' }, { projectDir: dir, env: EN }).json.hookSpecificOutput.additionalContext;
  assert.match(plan, /\nWhere to pick up: show the plan to the user and, after their go-ahead, continue with forge:execute\./);
});

test('post-batch in English', () => {
  const dir = projectWithCheck({ lint: true });
  edit(dir, 'bad.ts', 'BAD code', EN);
  const r = runHookScript('post-batch', { cwd: dir }, { projectDir: dir, env: EN });
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^forge: after your edits /);
  assert.match(ctx, /bad\.ts: BAD found/);
  assert.match(ctx, /Fix this before the next steps\.$/);
  assert.doesNotMatch(ctx, CYRILLIC);
});

test('language follows the last user message of the transcript when nothing forces it', () => {
  const dir = projectWithCheck();
  edit(dir, 'a.ts', '1', EN);
  const ru = stop(dir, { transcript_path: transcript('Hello there, please fix it', 'Исправь, пожалуйста, ошибку в проверке') }, AUTO);
  assert.match(ru.json.reason, /проверка перед завершением не прошла/);

  edit(dir, 'a.ts', '2', EN);
  const en = stop(dir, { transcript_path: transcript('Исправь, пожалуйста, ошибку', 'Now please fix the failing check and run it again') }, AUTO);
  assert.match(en.json.reason, /the check before finishing failed/);
  assert.doesNotMatch(en.json.reason, CYRILLIC);

  const start = runHookScript('session-start', { cwd: dir, source: 'resume', transcript_path: transcript('Привет, продолжим работу над задачей') }, { projectDir: dir, env: AUTO });
  assert.match(start.json.hookSpecificOutput.additionalContext, /режим normal/);
});

test('profile language beats the transcript', () => {
  const dir = projectWithCheck();
  writeProfile(dir, { language: 'en', commands: { test: 'node check.mjs' }, verify: { steps: ['test'], on_stop: 'full' } });
  edit(dir, 'a.ts', '1', EN);
  const r = stop(dir, { transcript_path: transcript('Исправь, пожалуйста, ошибку в проверке') }, AUTO);
  assert.match(r.json.reason, /the check before finishing failed/);
});

test('stop stores state.lang when a profile exists and writes nothing without one', () => {
  const dir = projectWithCheck();
  assert.equal(stop(dir, { transcript_path: transcript('Привет, как дела у проекта') }, AUTO).stdout, '');
  assert.equal(state(dir).lang, 'ru');
  assert.equal(stop(dir, { transcript_path: transcript('Hello, how is the project doing') }, AUTO).stdout, '');
  assert.equal(state(dir).lang, 'en');
  const before = readFileSync(join(dir, '.forge', 'state.json'), 'utf8');
  stop(dir, { transcript_path: transcript('ok') }, AUTO); // too few letters: nothing detected, nothing changes
  assert.equal(readFileSync(join(dir, '.forge', 'state.json'), 'utf8'), before);

  const bare = gitRepo();
  assert.equal(stop(bare, { transcript_path: transcript('Привет, как дела у проекта') }, AUTO).stdout, '');
  assert.equal(existsSync(join(bare, '.forge')), false, 'no profile: no .forge directory is created');
});

test('state.lang is the fallback when the transcript says nothing', () => {
  const dir = projectWithCheck();
  write(dir, '.forge/state.json', { version: 1, lang: 'ru' });
  edit(dir, 'a.ts', '1', AUTO);
  const r = stop(dir, {}, AUTO);
  assert.match(r.json.reason, /проверка перед завершением не прошла/);
});

test('docs library messages in English', () => {
  inEnglish(() => {
    const dir = gitRepo('feature/x');
    write(dir, 'AGENTS.md', '# Agents\n');
    write(dir, 'sub/AGENTS.md', '# Sub\n');
    write(dir, 'other/CLAUDE.md', 'text\n');
    const issues = checkDocs(dir, { commands: { build: 'tsc' }, verify: { steps: ['build'] } });
    const byCode = Object.fromEntries(issues.map((i) => [i.code, i.message]));
    assert.match(byCode['missing-shim'], /^no sub\/CLAUDE\.md next to sub\/AGENTS\.md: forge docs --fix will create an @AGENTS\.md link$/);
    assert.match(byCode.unlisted, /^AGENTS\.md does not mention sub\/: add a row to the areas table$/);
    assert.match(byCode['claude-only'], /^other\/CLAUDE\.md has content but there is no AGENTS\.md next to it/);
    assert.match(byCode['verify-undocumented'], /^verify command "tsc" \(step build\) is not mentioned in any agent file$/);
    for (const issue of issues) assert.doesNotMatch(issue.message, CYRILLIC, issue.code);
    assert.equal(fitList(['a', 'b', 'c'], 1), 'a and 2 more');
    assert.equal(fitList(['a', 'b'], 100, ' and '), 'a and b');
  });
});

test('changelog library messages in English', () => {
  inEnglish(() => {
    const parsedText = '# Changelog\n\n## [Unreleased]\n\n### Added\n- a\n\n### Changed\n- b\n';
    assert.equal(suggestBump({ unreleased: { sections: [] } }, '1.0.0').reason, 'no entries in Unreleased');
    assert.throws(() => releaseChangelog(parsedText, { version: 'x', date: '2026-01-01' }), /does not look like semver/);
    assert.throws(() => releaseChangelog(parsedText, { version: '1.0.0', date: '01.01.2026' }), /not in YYYY-MM-DD format/);
    assert.throws(() => releaseChangelog('# Changelog\n', { version: '1.0.0', date: '2026-01-01' }), /no "## \[Unreleased\]" section/);
    const issues = checkChangelog('# Changelog\n\n## [1.0.0] - 2026-13-45\n\n- x\n\n## [1.1.0] - 2026-01-01\n\n- y\n');
    assert.deepEqual(issues.map((i) => i.code).sort(), ['bad-date', 'no-unreleased', 'version-order']);
    for (const issue of issues) assert.doesNotMatch(issue.message, CYRILLIC, issue.code);
    assert.match(issues.find((i) => i.code === 'version-order').message, /^Version 1\.0\.0 is above 1\.1\.0: versions must descend/);
    const stray = checkChangelog('# Changelog\n\n## [Unreleased]\n\n[0.9.0]: https://example.com\n\n## [1.0.0] - 2026-01-01\n\n- a\n').find((i) => i.code === 'stray-link');
    assert.match(stray.message, /: comparison links and the release won't see it\.$/);
    const major = (text, version) => suggestBump(parseChangelog(`# Changelog\n\n## [Unreleased]\n\n### Changed\n- ${text}\n`), version);
    assert.equal(major('BREAKING: new format', '1.0.0').reason, 'has BREAKING, "breaking change" or "несовместим"');
    assert.match(major('BREAKING: new format', '0.3.0').reason, / \(before 1\.0 a major bump becomes minor\)$/);
  });
});

test('release library messages in English', () => {
  inEnglish(() => {
    const dir = tempDir();
    write(dir, 'package.json', '{"name":"x"}\n');
    write(dir, 'a.cfg', 'v=1\n');
    assert.equal(readVersion(dir, 'package.json').error, 'field "version" not found');
    assert.equal(readVersion(dir, 'nope.json').error, 'file not found');
    assert.equal(readVersion(dir, 'a.cfg').error, 'unknown version file type: specify a pattern');
    assert.match(readVersion(dir, { path: 'a.cfg', pattern: '(' }).error, /^invalid pattern/);
    assert.equal(readVersion(dir, { path: 'a.cfg', pattern: 'zzz(\\d)' }).error, 'pattern matched nothing in the file');
  });
});
