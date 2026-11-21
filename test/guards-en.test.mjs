import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBash, checkFile } from '../lib/guards.mjs';
import { setLang } from '../lib/i18n.mjs';
import { DEFAULT_PROTECTED_FILES } from '../lib/profile.mjs';
import { PLUGIN_ROOT, gitRepo, runHookScript } from './helpers.mjs';

const root = '/work/project';
const ctx = (branch = 'feature/x') => ({
  cwd: root,
  root,
  protectedBranches: ['main', 'master', 'release/*'],
  currentBranch: () => branch,
});
const CYRILLIC = /[Ѐ-ӿ]/;

/** Run fn with English messages, restoring Russian for the other test files' sake. */
function inEnglish(fn) {
  setLang('en');
  try {
    fn();
  } finally {
    setLang('ru');
  }
}

test('every Bash guard verdict reads in English', () => {
  inEnglish(() => {
    const cases = [
      ['git push --mirror origin', 'deny', /--mirror overwrites every branch/],
      ['git push origin main', 'deny', /protected branch "main"/],
      ['git push --force --force-with-lease origin feature/x', 'deny', /even together with --force-with-lease: --force cancels/],
      ['git push --force-with-lease origin +feature/x', 'deny', /\+refspec cancels the lease check/],
      ['git push --force origin feature/x', 'deny', /git push --force is forbidden\. For your own branch/],
      ['git push --no-verify origin feature/x', 'deny', /bypasses the project git hooks/],
      ['git push --all origin', 'ask', /every local branch.*Confirm\./],
      ['git commit --no-verify -m x', 'deny', /pre-commit checks — forbidden/],
      ['git commit -n -m x', 'deny', /-n \(--no-verify\) bypasses/],
      ['git reset --hard', 'ask', /wipes uncommitted changes\. Confirm\./],
      ['rm -rf /etc/x', 'ask', /rm -r outside the project.*\/etc\/x → .*etc[\\/]x.*Confirm\./],
      ['rm -rf $(pwd)/build', 'ask', /\(path is only known at run time\)/],
      ['echo $(git status', 'ask', /unterminated substitution/],
      ['echo $(echo $(echo $(echo $(git status))))', 'ask', /nested too deeply/],
    ];
    for (const [cmd, decision, re] of cases) {
      const v = checkBash(cmd, ctx());
      assert.equal(v.decision, decision, cmd);
      assert.match(v.reason, re, cmd);
      assert.match(v.reason, /^forge: /, cmd);
      assert.doesNotMatch(v.reason, CYRILLIC, cmd);
    }
  });
});

test('protected file verdict reads in English and keeps the quoted data', () => {
  inEnglish(() => {
    const v = checkFile(join(root, '.env'), { root, protectedFiles: DEFAULT_PROTECTED_FILES });
    assert.equal(v.decision, 'deny');
    assert.match(v.reason, /^forge: file "\.env" is protected \(pattern ".+" in protected_files\)\. Do not edit it/);
    assert.doesNotMatch(v.reason, CYRILLIC);
  });
});

test('hooks speak English under FORGE_LANG=en, including the fail-closed reason', () => {
  const repo = gitRepo('main');
  const env = { FORGE_LANG: 'en' };
  const bash = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git push' } }, { projectDir: repo, env });
  const bashReason = bash.json.hookSpecificOutput.permissionDecisionReason;
  assert.match(bashReason, /protected branch "main"/);
  assert.doesNotMatch(bashReason, CYRILLIC);

  const edit = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, '.env') } }, { projectDir: repo, env });
  assert.match(edit.json.hookSpecificOutput.permissionDecisionReason, /file "\.env" is protected/);
  assert.doesNotMatch(edit.json.hookSpecificOutput.permissionDecisionReason, CYRILLIC);

  const throwing = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(join(PLUGIN_ROOT, 'test', 'throwing-guards.mjs')).href}` };
  const brokenBash = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: repo, env: throwing });
  assert.equal(brokenBash.json.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(brokenBash.json.hookSpecificOutput.permissionDecisionReason, /internal error while checking the command/);
  assert.doesNotMatch(brokenBash.json.hookSpecificOutput.permissionDecisionReason, CYRILLIC);
  const brokenEdit = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.txt') } }, { projectDir: repo, env: throwing });
  assert.match(brokenEdit.json.hookSpecificOutput.permissionDecisionReason, /internal error while checking protected files/);
  assert.doesNotMatch(brokenEdit.json.hookSpecificOutput.permissionDecisionReason, CYRILLIC);

  // the same failure in Russian
  const ru = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: repo, env: { ...throwing, FORGE_LANG: 'ru' } });
  assert.match(ru.json.hookSpecificOutput.permissionDecisionReason, /внутренняя ошибка проверки команды/);
});

test('fail-closed reason falls back to English when the i18n modules cannot load', () => {
  const repo = gitRepo('main');
  const r = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }, {
    projectDir: repo,
    env: { FORGE_LANG: 'ru', NODE_OPTIONS: `--import=${pathToFileURL(join(PLUGIN_ROOT, 'test', 'throwing-guards.mjs')).href}`, FORGE_TEST_BROKEN_MODULE: 'i18n' },
  });
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /internal error while checking the command/);
});
