import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyConfigDir, git, gitRepo, PLUGIN_ROOT, runHookScript, tempDir, write, writeProfile } from './helpers.mjs';

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

test('guard hooks fail closed: an error inside the guard asks instead of allowing', () => {
  const repo = gitRepo('main');
  const throwing = { NODE_OPTIONS: `--import=${pathToFileURL(join(PLUGIN_ROOT, 'test', 'throwing-guards.mjs')).href}` };
  const bash = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: repo, env: throwing });
  assert.equal(bash.code, 0);
  assert.equal(bash.json?.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(bash.json.hookSpecificOutput.permissionDecisionReason, /forge/);
  const edit = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.txt') } }, { projectDir: repo, env: throwing });
  assert.equal(edit.json?.hookSpecificOutput.permissionDecision, 'ask');

  // a real failure: an invalid protected_files glob makes the matcher throw
  writeProfile(repo, { protected_files: ['{*}'] });
  const glob = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.txt') } }, { projectDir: repo });
  assert.equal(glob.json?.hookSpecificOutput.permissionDecision, 'ask');
});

test('guard hooks fail closed when a module fails to load or the project root cannot be resolved', () => {
  const repo = gitRepo('main');
  const seam = `--import=${pathToFileURL(join(PLUGIN_ROOT, 'test', 'throwing-guards.mjs')).href}`;
  for (const mod of ['guards', 'profile', 'paths']) {
    const env = { NODE_OPTIONS: seam, FORGE_TEST_BROKEN_MODULE: mod };
    const bash = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: repo, env });
    assert.equal(bash.code, 0, mod);
    assert.equal(bash.json?.hookSpecificOutput.permissionDecision, 'ask', `pre-bash, broken ${mod}`);
    const edit = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.txt') } }, { projectDir: repo, env });
    assert.equal(edit.json?.hookSpecificOutput.permissionDecision, 'ask', `pre-edit, broken ${mod}`);
  }
});

test('pre-bash: pathological nesting before a protected push asks, never allows', () => {
  const repo = gitRepo('main');
  for (const command of [
    'echo ' + '$('.repeat(3000) + 'x' + ')'.repeat(3000) + '; git push --force origin main',
    'echo ' + '$(( '.repeat(26) + 'x' + ' ) )'.repeat(26) + '; git push --force origin main',
  ]) {
    const r = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command } }, { projectDir: repo });
    assert.ok(['ask', 'deny'].includes(r.json?.hookSpecificOutput.permissionDecision), command.slice(0, 30));
    assert.ok(r.ms < 5000, `${r.ms} ms`);
  }
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

const PKG = { name: 'demo', scripts: { test: 'node --test' }, dependencies: { a: '1.0.0' } };

/**
 * A project with a root AGENTS.md, a committed package.json and (optionally) backend/ — in git unless `git: false`.
 * The first Stop is already done, so the docs cursor exists.
 */
function docsProject({ useGit = true, docs, verify = { on_stop: 'off' }, commands, agents = '# Agents\n', backend = false } = {}) {
  const dir = useGit ? gitRepo('feature/x') : tempDir();
  write(dir, 'AGENTS.md', agents);
  write(dir, 'CLAUDE.md', '@AGENTS.md\n');
  write(dir, 'package.json', PKG);
  if (backend) {
    write(dir, 'backend/AGENTS.md', '# Backend\n');
    write(dir, 'backend/package.json', PKG);
  }
  if (useGit) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  writeProfile(dir, { ...(commands ? { commands } : {}), verify, ...(docs ? { docs } : {}) });
  assert.equal(stop(dir).stdout, '', 'first stop only sets the cursor');
  return dir;
}

test('stop docs: first stop sets the cursor; changed scripts remind once', () => {
  const dir = gitRepo('feature/x');
  write(dir, 'AGENTS.md', '# Agents\n');
  write(dir, 'package.json', PKG);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  writeProfile(dir, { verify: { on_stop: 'off' } });
  edit(dir, 'package.json', { ...PKG, scripts: { test: 'node --test', lint: 'eslint .' } });
  assert.equal(stop(dir).stdout, '', 'no cursor yet: edits before it are not reminded about');
  assert.equal(state(dir).docs.offset, readFileSync(join(dir, '.forge', 'edits.jsonl')).length);

  edit(dir, 'package.json', { ...PKG, scripts: { test: 'node --test', build: 'tsc' } });
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /^forge: /);
  assert.match(r.json.reason, /package\.json \(scripts\)/);
  assert.match(r.json.reason, /AGENTS\.md/);
  assert.ok(r.json.reason.length <= 600);
  assert.equal(stop(dir, { stop_hook_active: true }).stdout, '', 'no new edits → no second reminder');
});

test('stop docs: package.json dependencies alone count only without git', () => {
  const deps = { ...PKG, dependencies: { a: '2.0.0', b: '1.0.0' } };
  const inGit = docsProject();
  edit(inGit, 'package.json', deps);
  assert.equal(stop(inGit).stdout, '', 'git: scripts unchanged → no reminder');

  const plain = docsProject({ useGit: false });
  edit(plain, 'package.json', deps);
  const r = stop(plain);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /package\.json/);
});

test('stop docs: an edit of the nearest agent file in the same window closes the change', () => {
  const ci = docsProject();
  edit(ci, '.github/workflows/x.yml', 'on: push\n');
  edit(ci, 'AGENTS.md', '# Agents\n\nCI: x.yml\n');
  assert.equal(stop(ci).stdout, '', 'root AGENTS.md closes everything');

  const nested = docsProject({ backend: true });
  edit(nested, 'backend/package.json', { ...PKG, scripts: { start: 'node .' } });
  edit(nested, 'backend/AGENTS.md', '# Backend\n\nnpm start\n');
  assert.equal(stop(nested).stdout, '', 'backend/AGENTS.md closes changes inside backend/');

  const outside = docsProject({ backend: true });
  edit(outside, 'package.json', { ...PKG, scripts: { start: 'node .' } });
  edit(outside, 'backend/AGENTS.md', '# Backend\n\nnpm start\n');
  const r = stop(outside);
  assert.equal(r.json.decision, 'block', 'backend/AGENTS.md does not cover the root package.json');
  assert.match(r.json.reason, /package\.json \(scripts\)/);
});

test('stop docs: a new top-level directory not mentioned in AGENTS.md', () => {
  const dir = docsProject();
  edit(dir, 'tools/gen.mjs', 'export {}\n');
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /новый каталог tools\//);

  const mentioned = docsProject({ agents: '# Agents\n\n`tools/` — генераторы\n' });
  edit(mentioned, 'tools/gen.mjs', 'export {}\n');
  assert.equal(stop(mentioned).stdout, '');

  const existing = docsProject();
  edit(existing, 'notes.md', 'root-level files never count\n');
  assert.equal(stop(existing).stdout, '');
});

test('stop docs: a failing check wins; the reminder comes after the fix', () => {
  const dir = docsProject({ commands: { test: 'node check.mjs' }, verify: { steps: ['test'], on_stop: 'full' } });
  write(dir, 'check.mjs', "import { readFileSync } from 'node:fs';\nif (readFileSync('status.txt','utf8').trim() !== 'ok') { console.error('check failed'); process.exit(1); }\n");
  write(dir, 'status.txt', 'fail');
  edit(dir, 'package.json', { ...PKG, scripts: { test: 'node check.mjs' } });
  const blocked = stop(dir);
  assert.equal(blocked.json.decision, 'block');
  assert.match(blocked.json.reason, /проверка перед завершением не прошла/);
  assert.doesNotMatch(blocked.json.reason, /AGENTS\.md/);

  edit(dir, 'status.txt', 'ok');
  const r = stop(dir, { stop_hook_active: true });
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /package\.json \(scripts\)/);
  assert.equal(state(dir).verify.ok, true);
});

test('stop docs: the one-time "check failed" message and the reminder share one response', () => {
  const dir = docsProject({ commands: { test: 'node -e "process.exit(1)"' }, verify: { steps: ['test'], on_stop: 'full' } });
  edit(dir, 'package.json', { ...PKG, scripts: { x: 'y' } });
  assert.equal(stop(dir).json.decision, 'block');
  const r = stop(dir, { stop_hook_active: true });
  assert.match(r.json.systemMessage, /последняя проверка не прошла/);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /package\.json \(scripts\)/);
});

test('stop docs: no reminder when verification gives up; it comes after a later passing check', () => {
  const dir = docsProject({ commands: { test: 'node check.mjs' }, verify: { steps: ['test'], on_stop: 'full' } });
  write(dir, 'check.mjs', "import { readFileSync } from 'node:fs';\nif (readFileSync('status.txt','utf8').trim() !== 'ok') { console.error('check failed'); process.exit(1); }\n");
  write(dir, 'status.txt', 'fail');
  edit(dir, 'package.json', { ...PKG, scripts: { x: 'y' } });
  assert.equal(stop(dir).json.decision, 'block');
  edit(dir, 'a.txt', '2');
  assert.equal(stop(dir, { stop_hook_active: true }).json.decision, 'block');
  edit(dir, 'a.txt', '3');
  const docsOffset = state(dir).docs.offset;
  const gaveUp = stop(dir, { stop_hook_active: true });
  assert.match(gaveUp.json.systemMessage, /3 раз\(а\) подряд/);
  assert.equal(gaveUp.json.decision, undefined, 'giving up must not block');
  assert.equal(gaveUp.json.reason, undefined);
  assert.equal(gaveUp.json.gaveUp, undefined, 'internal marker is not printed');
  assert.equal(state(dir).docs.offset, docsOffset, 'docs cursor stays put');

  edit(dir, 'status.txt', 'ok');
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /package\.json \(scripts\)/);
});

test('stop docs: a caught-up log past 256 KiB is rotated and all three cursors reset', () => {
  const dir = docsProject();
  const log = join(dir, '.forge', 'edits.jsonl');
  writeFileSync(log, `${JSON.stringify({ t: 0, f: 'gone.txt' })}\n`.repeat(12000));
  const size = readFileSync(log).length;
  assert.ok(size >= 256 * 1024);
  const s = state(dir);
  s.verify = { ok: true, summary: 'ok', edits_offset: size, notified: false };
  s.lint_offset = size;
  s.docs.offset = size;
  writeFileSync(join(dir, '.forge', 'state.json'), JSON.stringify(s));

  assert.equal(stop(dir).stdout, '');
  assert.equal(readFileSync(log).length, 0, 'log truncated');
  const after = state(dir);
  assert.deepEqual([after.verify.edits_offset, after.lint_offset, after.docs.offset], [0, 0, 0]);
});

test('stop docs: remind false and projects without AGENTS.md stay silent', () => {
  const off = docsProject({ docs: { remind: false } });
  edit(off, 'package.json', { ...PKG, scripts: { x: 'y' } });
  assert.equal(stop(off).stdout, '');

  const none = docsProject();
  git(none, 'rm', '-q', 'AGENTS.md');
  edit(none, 'package.json', { ...PKG, scripts: { x: 'y' } });
  assert.equal(stop(none).stdout, '');
});

test('stop docs: a truncated log is read from the start, one reminder', () => {
  const dir = docsProject();
  edit(dir, 'package.json', { ...PKG, scripts: { x: 'y' } });
  const s = state(dir);
  s.docs.offset = 1e6;
  writeFileSync(join(dir, '.forge', 'state.json'), JSON.stringify(s));
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /package\.json \(scripts\)/);
  assert.equal(stop(dir).stdout, '');
});

test('post-batch: lints files edited since the last batch, once', () => {
  const dir = projectWithCheck({ lint: true });
  edit(dir, 'good.ts', 'fine');
  assert.equal(runHookScript('post-batch', { cwd: dir }, { projectDir: dir }).stdout, '');

  edit(dir, 'bad.ts', 'BAD code');
  const r = runHookScript('post-batch', { cwd: dir }, { projectDir: dir });
  assert.equal(r.json.decision, undefined, 'must not stop the loop');
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolBatch');
  assert.match(r.json.hookSpecificOutput.additionalContext, /bad\.ts: BAD found/);
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
