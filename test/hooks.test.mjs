import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyConfigDir, gitRepo, runHookScript, tempDir, write, writeProfile } from './helpers.mjs';

/** A project whose "test" step passes or fails depending on the content of status.txt. */
function projectWithCheck({ on_stop = 'full', lint = false } = {}) {
  const dir = gitRepo('feature/x');
  write(dir, 'status.txt', 'fail');
  write(dir, 'check.mjs', "import { readFileSync } from 'node:fs';\nconst s = readFileSync('status.txt','utf8').trim();\nif (s !== 'ok') { console.error('check failed: ' + s); process.exit(1); }\n");
  write(dir, 'lint.mjs', "import { readFileSync } from 'node:fs';\nfor (const f of process.argv.slice(2)) if (readFileSync(f,'utf8').includes('BAD')) { console.error(f + ': BAD found'); process.exit(1); }\n");
  const commands = { test: 'node check.mjs' };
  if (lint) commands.lint = 'node lint.mjs {files}';
  writeProfile(dir, { commands, verify: { steps: ['test'], on_stop } });
  return dir;
}

const edit = (dir, rel, content = 'x') => {
  const file = write(dir, rel, content);
  return runHookScript('post-edit', { cwd: dir, tool_name: 'Write', tool_input: { file_path: file } }, { projectDir: dir });
};
const stop = (dir, extra = {}) =>
  runHookScript('stop', { cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, ...extra }, { projectDir: dir });
const state = (dir) => JSON.parse(readFileSync(join(dir, '.forge', 'state.json'), 'utf8'));

test('session-start: silent outside a repo, one hint in a repo without profile', () => {
  const plain = tempDir();
  assert.equal(runHookScript('session-start', { cwd: plain, source: 'startup' }, { projectDir: plain }).stdout, '');

  const repo = gitRepo();
  const r = runHookScript('session-start', { cwd: repo, source: 'startup' }, { projectDir: repo });
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\/forge:init/);
  assert.ok(ctx.length <= 600);
});

test('session-start: profile summary under 600 chars, Superpowers warning', () => {
  const dir = projectWithCheck();
  const configDir = emptyConfigDir();
  write(configDir, 'settings.json', { enabledPlugins: { 'superpowers@claude-plugins-official': true } });
  const r = runHookScript('session-start', { cwd: dir, source: 'resume' }, { projectDir: dir, configDir });
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /режим normal/);
  assert.match(ctx, /Superpowers/);
  assert.ok(ctx.length <= 600, `length ${ctx.length}`);
});

test('session-start: mentions ignored routing overrides, silent for a valid profile', () => {
  const bad = gitRepo('feature/x');
  writeProfile(bad, { routing: { normal: { senior: 'sonnet/medium' } } });
  const ctx = runHookScript('session-start', { cwd: bad, source: 'startup' }, { projectDir: bad })
    .json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /routing/);
  assert.ok(ctx.length <= 600, `length ${ctx.length}`);

  const good = gitRepo('feature/y');
  writeProfile(good, { routing: { normal: { implementer: 'opus/high' } } });
  const ok = runHookScript('session-start', { cwd: good, source: 'startup' }, { projectDir: good })
    .json.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ok, /routing/);
});

test('pre-bash: deny JSON for a protected push, silence for ordinary commands', () => {
  const repo = gitRepo('main');
  const deny = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git push' } }, { projectDir: repo });
  assert.equal(deny.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.json.hookSpecificOutput.permissionDecisionReason, /main/);
  const ok = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls -la && git status' } }, { projectDir: repo });
  assert.equal(ok.stdout, '');
  assert.equal(ok.code, 0);
});

test('pre-edit: protected file denied, profile can unprotect', () => {
  const repo = gitRepo();
  const env = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, '.env') } }, { projectDir: repo });
  assert.equal(env.json.hookSpecificOutput.permissionDecision, 'deny');
  writeProfile(repo, { protected_files: ['!.env'] });
  const allowed = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, '.env') } }, { projectDir: repo });
  assert.equal(allowed.stdout, '');
});

test('hooks fail open on garbage input', () => {
  const repo = gitRepo();
  const r = runHookScript('pre-bash', 'not an object', { projectDir: repo });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('post-edit leaves no files in a project without a profile', () => {
  const repo = gitRepo();
  edit(repo, 'a.txt');
  assert.equal(existsSync(join(repo, '.forge')), false);
});

test('stop: verifies only after edits, blocks on failure, passes after a fix', () => {
  const dir = projectWithCheck();
  assert.equal(stop(dir).stdout, '', 'no edits → nothing to verify');

  edit(dir, 'src/a.ts');
  const blocked = stop(dir);
  assert.equal(blocked.json.decision, 'block');
  assert.match(blocked.json.reason, /check failed: fail/);
  assert.equal(state(dir).failures.verify_streak, 1);

  const again = stop(dir, { stop_hook_active: true });
  assert.match(again.json.systemMessage, /последняя проверка не прошла/, 'user is told once');
  assert.equal(stop(dir).stdout, '', '…and only once');

  writeFileSync(join(dir, 'status.txt'), 'ok');
  edit(dir, 'src/a.ts', 'fixed');
  assert.equal(stop(dir, { stop_hook_active: true }).stdout, '');
  assert.equal(state(dir).verify.ok, true);
  assert.equal(state(dir).failures.verify_streak, 0);
});

test('stop: suggests the debugger on the 2nd failure, gives up on the 3rd', () => {
  const dir = projectWithCheck();
  edit(dir, 'a.ts', '1');
  assert.equal(stop(dir).json.decision, 'block');
  edit(dir, 'a.ts', '2');
  const second = stop(dir, { stop_hook_active: true });
  assert.match(second.json.reason, /debugger/);
  edit(dir, 'a.ts', '3');
  const third = stop(dir, { stop_hook_active: true });
  assert.equal(third.json.decision, undefined);
  assert.match(third.json.systemMessage, /3 раз\(а\) подряд/);
});

test('stop: waits while subagents are still running; off means off', () => {
  const dir = projectWithCheck();
  edit(dir, 'a.ts');
  const busy = stop(dir, { background_tasks: [{ id: '1', type: 'subagent', status: 'running' }] });
  assert.equal(busy.stdout, '');
  assert.equal(existsSync(join(dir, '.forge', 'state.json')), false);

  const off = projectWithCheck({ on_stop: 'off' });
  edit(off, 'a.ts');
  assert.equal(stop(off).stdout, '');
});

test('post-batch: lints files edited since the last batch, once', () => {
  const dir = projectWithCheck({ lint: true });
  edit(dir, 'good.ts', 'fine');
  assert.equal(runHookScript('post-batch', { cwd: dir }, { projectDir: dir }).stdout, '');

  edit(dir, 'bad.ts', 'BAD code');
  const r = runHookScript('post-batch', { cwd: dir }, { projectDir: dir });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /bad\.ts: BAD found/);
  assert.equal(runHookScript('post-batch', { cwd: dir }, { projectDir: dir }).stdout, '', 'cursor advanced');
});

test('guard hooks stay fast', () => {
  const repo = gitRepo();
  const times = Array.from({ length: 5 }, () =>
    runHookScript('pre-bash', { cwd: repo, tool_input: { command: 'git push origin feature' } }, { projectDir: repo }).ms,
  ).sort((a, b) => a - b);
  // generous bound for CI noise; the median is printed for the record
  console.log(`pre-bash median ${times[2]} ms`);
  assert.ok(times[2] < 1000);
});
