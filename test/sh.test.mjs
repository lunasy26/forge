import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../lib/i18n.mjs';
import { doctorShellLine, resolveShell, shellMissingMessage } from '../lib/sh.mjs';
import { runShell } from '../lib/verify.mjs';
import { tempDir } from './helpers.mjs';

setLang('ru'); // assertions below check the Russian texts

const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const noGit = () => null;
const having = (...paths) => (p) => paths.includes(p);

test('resolveShell: POSIX is /bin/sh without looking at the filesystem', () => {
  const exists = () => { throw new Error('must not be called'); };
  assert.equal(resolveShell({ platform: 'linux', env: {}, exists, gitExecPath: noGit }), '/bin/sh');
  assert.equal(resolveShell({ platform: 'darwin', env: { CLAUDE_CODE_GIT_BASH_PATH: 'x' }, exists, gitExecPath: noGit }), '/bin/sh');
});

test('resolveShell win32: CLAUDE_CODE_GIT_BASH_PATH wins when it exists', () => {
  const custom = 'D:\\tools\\bash.exe';
  const env = { CLAUDE_CODE_GIT_BASH_PATH: custom, ProgramFiles: 'C:\\Program Files' };
  const exists = having(custom, BASH);
  assert.equal(resolveShell({ platform: 'win32', env, exists, gitExecPath: noGit }), custom);
});

test('resolveShell win32: a missing CLAUDE_CODE_GIT_BASH_PATH falls through', () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone\\bash.exe', ProgramFiles: 'C:\\Program Files' };
  assert.equal(resolveShell({ platform: 'win32', env, exists: having(BASH), gitExecPath: noGit }), BASH);
});

test('resolveShell win32: derived from git --exec-path', () => {
  const bash = 'D:\\Dev\\Git\\bin\\bash.exe';
  const gitExecPath = () => 'D:/Dev/Git/mingw64/libexec/git-core';
  assert.equal(resolveShell({ platform: 'win32', env: {}, exists: having(bash), gitExecPath }), bash);
  // exec path wins over the Program Files fallback
  const env = { ProgramFiles: 'C:\\Program Files' };
  assert.equal(resolveShell({ platform: 'win32', env, exists: having(bash, BASH), gitExecPath }), bash);
});

test('resolveShell win32: Program Files, Program Files (x86), then LocalAppData', () => {
  const x86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
  const local = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  };
  const run = (...present) => resolveShell({ platform: 'win32', env, exists: having(...present), gitExecPath: noGit });
  assert.equal(run(BASH, x86, local), BASH);
  assert.equal(run(x86, local), x86);
  assert.equal(run(local), local);
});

test('resolveShell win32: nothing found is null; unset variables are skipped', () => {
  assert.equal(resolveShell({ platform: 'win32', env: {}, exists: () => false, gitExecPath: noGit }), null);
  assert.equal(resolveShell({ platform: 'win32', env: {}, exists: () => true, gitExecPath: noGit }), null);
  const env = { ProgramFiles: 'C:\\Program Files' };
  assert.equal(resolveShell({ platform: 'win32', env, exists: () => false, gitExecPath: () => 'C:/Git/mingw64/libexec/git-core' }), null);
});

test('runShell: no shell is a failed result with a clear message, not an exception', () => {
  const r = runShell('echo hi', { cwd: tempDir(), timeoutMs: 5000, shell: null });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.code, null);
  assert.match(r.output, /Git Bash не найден/);
  assert.equal(r.output, shellMissingMessage());
});

test('runShell: an explicit shell is used', { skip: process.platform === 'win32' }, () => {
  const r = runShell('echo hi', { cwd: tempDir(), timeoutMs: 5000, shell: '/bin/sh' });
  assert.equal(r.ok, true);
  assert.equal(r.output.trim(), 'hi');
});

test('doctorShellLine: only on win32, ok with the path or a hint when missing', () => {
  assert.equal(doctorShellLine({ platform: 'linux', shell: null }), null);
  assert.deepEqual(doctorShellLine({ platform: 'win32', shell: BASH }), { ok: true, text: `Git Bash: ${BASH}` });
  const bad = doctorShellLine({ platform: 'win32', shell: null });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /^Git Bash не найден — .*CLAUDE_CODE_GIT_BASH_PATH/);
  setLang('en');
  try {
    assert.match(doctorShellLine({ platform: 'win32', shell: null }).text, /^Git Bash not found — install Git for Windows/);
    assert.match(shellMissingMessage(), /^forge: Git Bash not found/);
  } finally {
    setLang('ru');
  }
});
