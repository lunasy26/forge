import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureRepo, emptyConfigDir, git, gitRepo, OUTER_TMPDIR, PLUGIN_ROOT, runHookScript, tempDir, write, writeProfile } from './helpers.mjs';

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

const PLAN_MD = '- [x] T1 Разобрать план\n  depends: -\n\n- [ ] T2 Подключить хук\n  depends: T3\n\n- [ ] T3 Написать тесты\n  depends: T1\n';
const withTask = (dir, state) =>
  write(dir, '.forge/state.json', { version: 1, tier: 2, task: { slug: 'resume' }, artifacts: { plan: '.forge/work/resume/plan.md' }, ...state });
const sessionCtx = (dir, source, opts = {}) =>
  runHookScript('session-start', { cwd: dir, source }, { projectDir: dir, ...opts }).json.hookSpecificOutput.additionalContext;

test('session-start: after compact or resume — next ready task from the plan and the skill for the stage', () => {
  const dir = projectWithCheck();
  write(dir, '.forge/work/resume/plan.md', PLAN_MD);
  withTask(dir, { stage: 'execute' });
  const line = 'Где продолжить: следующая задача T3 «Написать тесты» (выполнено 1/3); продолжай скиллом forge:execute.';
  for (const source of ['compact', 'resume']) {
    const ctx = sessionCtx(dir, source);
    assert.ok(ctx.split('\n').includes(line), ctx);
    assert.match(ctx, /Активная задача: resume, стадия execute, план \.forge\/work\/resume\/plan\.md\.\n/);
  }
  for (const source of ['startup', 'clear']) {
    const ctx = sessionCtx(dir, source);
    assert.match(ctx, /Активная задача: resume/);
    assert.doesNotMatch(ctx, /Где продолжить/);
  }

  withTask(dir, { stage: 'plan' });
  assert.match(sessionCtx(dir, 'compact'), /\(выполнено 1\/3\); покажи план пользователю и после согласия продолжай скиллом forge:execute\./);

  write(dir, '.forge/work/resume/plan.md', '- [x] T1 a\n- [x] T2 b\n');
  withTask(dir, { stage: 'review' });
  assert.match(sessionCtx(dir, 'compact'), /: все задачи плана отмечены \(2\); продолжай скиллом forge:review\./);
});

test('session-start: without a readable plan only the stage hint, without a hint no line', () => {
  const dir = projectWithCheck();
  withTask(dir, { stage: 'spec', artifacts: {} });
  assert.match(sessionCtx(dir, 'compact'), /\nГде продолжить: продолжай скиллом forge:plan\./);

  withTask(dir, { stage: 'execute' }); // the plan file does not exist
  assert.match(sessionCtx(dir, 'compact'), /\nГде продолжить: продолжай скиллом forge:execute\./);

  withTask(dir, { stage: 'finish' });
  assert.match(sessionCtx(dir, 'compact'), /\nГде продолжить: продолжай скиллом forge:finish\./);

  withTask(dir, { stage: null });
  assert.doesNotMatch(sessionCtx(dir, 'compact'), /Где продолжить/);

  write(dir, '.forge/state.json', { version: 1, stage: 'execute', artifacts: { plan: '.forge/work/resume/plan.md' } });
  assert.doesNotMatch(sessionCtx(dir, 'compact'), /Где продолжить/); // no active task
});

test('session-start: the resume line fits in 600 chars with everything else switched on', () => {
  const dir = gitRepo('feature/x');
  writeProfile(dir, { verify: { steps: ['test'] }, routing: { normal: { senior: 'sonnet/medium' } } });
  const slug = 'a-rather-long-feature-slug-for-the-budget';
  write(dir, `.forge/work/${slug}/plan.md`, `- [ ] T12 ${'Очень длинный заголовок задачи '.repeat(8)}\n`);
  write(dir, '.forge/state.json', { version: 1, tier: 2, stage: 'execute', task: { slug }, artifacts: { plan: `.forge/work/${slug}/plan.md` }, verify: { ok: false, summary: 'test: 3 failing' } });
  const configDir = emptyConfigDir();
  write(configDir, 'settings.json', { enabledPlugins: { 'superpowers@claude-plugins-official': true } });
  const ctx = sessionCtx(dir, 'compact', { configDir });
  assert.ok(ctx.length <= 600, `length ${ctx.length}`);
  assert.match(ctx, /следующая задача T12 «Очень длинный[^»]*…» \(выполнено 0\/1\); продолжай скиллом forge:execute\./);
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

test('session-start: one docs line for a missing or unlinked AGENTS.md, only with a profile', () => {
  const ctxOf = (dir, opts = {}) =>
    runHookScript('session-start', { cwd: dir, source: 'startup' }, { projectDir: dir, ...opts }).json.hookSpecificOutput
      .additionalContext;

  const missing = gitRepo('feature/x');
  writeProfile(missing, {});
  const m = ctxOf(missing);
  assert.match(m, /нет AGENTS\.md — \/forge:docs/);
  assert.ok(m.length <= 600, `length ${m.length}`);

  const unlinked = gitRepo('feature/x');
  writeProfile(unlinked, {});
  write(unlinked, 'AGENTS.md', '# Project\n');
  write(unlinked, 'CLAUDE.md', '# Notes\n');
  const u = ctxOf(unlinked);
  assert.match(u, /CLAUDE\.md не подключает AGENTS\.md — forge docs/);
  assert.doesNotMatch(u, /нет AGENTS\.md/);

  const ok = gitRepo('feature/x');
  writeProfile(ok, {});
  write(ok, 'AGENTS.md', '# Project\n');
  write(ok, 'CLAUDE.md', '@AGENTS.md\n');
  assert.doesNotMatch(ctxOf(ok), /AGENTS\.md/);

  const noProfile = gitRepo('feature/x');
  assert.doesNotMatch(ctxOf(noProfile), /AGENTS\.md/);

  const configDir = emptyConfigDir();
  write(configDir, 'settings.json', { enabledPlugins: { 'superpowers@claude-plugins-official': true } });
  const both = ctxOf(missing, { configDir });
  assert.ok(both.indexOf('AGENTS.md') < both.indexOf('Superpowers'), 'docs line comes before the Superpowers line');
  assert.ok(both.length <= 600, `length ${both.length}`);
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

test('pre-bash: the PowerShell tool is guarded with PowerShell rules', () => {
  const repo = gitRepo('feature/x');
  const run = (command) => runHookScript('pre-bash', { cwd: repo, tool_name: 'PowerShell', tool_input: { command } }, { projectDir: repo });
  const deny = run('git push origin main');
  assert.equal(deny.code, 0);
  assert.equal(deny.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.json.hookSpecificOutput.permissionDecisionReason, /main/);
  assert.equal(run('iex "git push --force"').json.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('powershell -EncodedCommand ZQBjAGgAbwA=').json.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(run('Get-ChildItem x | Remove-Item -Recurse').json.hookSpecificOutput.permissionDecision, 'ask');
  for (const command of ['git status; Get-ChildItem -Recurse', 'Remove-Item .\\build -Recurse -Force', 'echo "git push --force"']) {
    const ok = run(command);
    assert.equal(ok.stdout, '', command);
    assert.equal(ok.code, 0, command);
  }
  // hooks.json routes both shell tools to this hook
  const config = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = config.hooks.PreToolUse.find((h) => h.hooks[0].command.includes('pre-bash.mjs'));
  assert.deepEqual(entry.matcher.split('|').sort(), ['Bash', 'PowerShell']);
  // a PowerShell-only spelling is not read as Bash, and a Bash-only one not as PowerShell
  assert.equal(
    runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'iex "git push --force"' } }, { projectDir: repo }).stdout,
    '',
  );
});

test('pre-bash: a staged secret asks before git commit, secrets.check: false turns it off', () => {
  const token = 'gh' + 'p_' + 'A1b2'.repeat(9); // built at run time: no token literal in a source file
  const repo = gitRepo('feature/x');
  write(repo, 'src/config.js', `export const token = '${token}';\n`);
  git(repo, 'add', 'src/config.js');
  const run = (command, tool_name = 'Bash') => runHookScript('pre-bash', { cwd: repo, tool_name, tool_input: { command } }, { projectDir: repo });
  // without a profile the defaults apply: the check is on
  for (const tool of ['Bash', 'PowerShell']) {
    const r = run('git commit -m x', tool);
    assert.equal(r.code, 0, tool);
    assert.equal(r.json?.hookSpecificOutput.permissionDecision, 'ask', tool);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /src\/config\.js:1 — токен GitHub/, tool);
    assert.ok(!r.stdout.includes(token), tool);
  }
  assert.equal(run('git add .env').json?.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(run('git status').stdout, '');
  writeProfile(repo, { secrets: { ignore: ['src/**'] } });
  assert.equal(run('git commit -m x').stdout, '', 'ignored path');
  writeProfile(repo, { secrets: { check: false } });
  const off = run('git commit -m x');
  assert.equal(off.code, 0);
  assert.equal(off.stdout, '');
  assert.equal(run('git add .env').stdout, '');
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
  const ps = runHookScript('pre-bash', { cwd: repo, tool_name: 'PowerShell', tool_input: { command: 'Get-Date' } }, { projectDir: repo, env: throwing });
  assert.equal(ps.code, 0);
  assert.equal(ps.json?.hookSpecificOutput.permissionDecision, 'ask');
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
    const ps = runHookScript('pre-bash', { cwd: repo, tool_name: 'PowerShell', tool_input: { command: 'Get-Date' } }, { projectDir: repo, env });
    assert.equal(ps.json?.hookSpecificOutput.permissionDecision, 'ask', `pre-bash PowerShell, broken ${mod}`);
    const edit = runHookScript('pre-edit', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.txt') } }, { projectDir: repo, env });
    assert.equal(edit.json?.hookSpecificOutput.permissionDecision, 'ask', `pre-edit, broken ${mod}`);
  }
});

test('tests keep hook errors out of the shared temp log: a project without .forge logs to the isolated temp dir', () => {
  assert.notEqual(tmpdir(), OUTER_TMPDIR);
  const realLog = join(OUTER_TMPDIR, 'forge-errors.log');
  const before = existsSync(realLog) ? statSync(realLog).size : 0;
  const repo = gitRepo('main'); // no .forge/: errors go to <tmpdir>/forge-errors.log
  const env = { NODE_OPTIONS: `--import=${pathToFileURL(join(PLUGIN_ROOT, 'test', 'throwing-guards.mjs')).href}`, FORGE_TEST_BROKEN_MODULE: 'paths' };
  const r = runHookScript('pre-bash', { cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: repo, env });
  assert.equal(r.json?.hookSpecificOutput.permissionDecision, 'ask');
  const marker = pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'pre-bash.mjs')).href;
  assert.match(readFileSync(join(tmpdir(), 'forge-errors.log'), 'utf8'), /module failed to load/);
  // other processes may append to the real log meanwhile: only this hook's line must be absent
  const added = existsSync(realLog) ? readFileSync(realLog).subarray(before).toString('utf8') : '';
  assert.ok(!added.includes(marker), 'the hook wrote to the shared temp log');
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

test('stop docs: a reminded change is not reminded again until it changes; closing counts as reminded', () => {
  const dir = docsProject();
  const scripts = { test: 'node --test', build: 'tsc' };
  edit(dir, 'package.json', { ...PKG, scripts });
  assert.equal(stop(dir).json.decision, 'block', 'first time: reminder');
  edit(dir, 'AGENTS.md', '# Agents\n\nnpm run build\n');
  assert.equal(stop(dir).stdout, '', 'agent file updated');
  edit(dir, 'package.json', { ...PKG, scripts, dependencies: { a: '2.0.0' } });
  assert.equal(stop(dir).stdout, '', 'only dependencies changed since the reminder');
  edit(dir, 'package.json', { ...PKG, scripts: { ...scripts, lint: 'eslint .' }, dependencies: { a: '2.0.0' } });
  const again = stop(dir);
  assert.equal(again.json.decision, 'block', 'scripts changed again');
  assert.match(again.json.reason, /package\.json \(scripts\)/);

  // closed in the same window by an agent-file edit: later dependency edits stay quiet
  const closed = docsProject();
  edit(closed, 'package.json', { ...PKG, scripts });
  edit(closed, 'AGENTS.md', '# Agents\n\nnpm run build\n');
  assert.equal(stop(closed).stdout, '');
  edit(closed, 'package.json', { ...PKG, scripts, dependencies: { a: '3.0.0' } });
  assert.equal(stop(closed).stdout, '');
});

test('stop docs: memory is forgotten once scripts match HEAD again', () => {
  const dir = docsProject();
  const changed = { ...PKG, scripts: { test: 'node --test', build: 'tsc' } };
  edit(dir, 'package.json', changed);
  assert.equal(stop(dir).json.decision, 'block');
  edit(dir, 'package.json', PKG); // back to HEAD
  assert.equal(stop(dir).stdout, '');
  assert.deepEqual(state(dir).docs.reminded?.scripts ?? {}, {}, 'entry dropped');
  edit(dir, 'package.json', changed);
  assert.equal(stop(dir).json.decision, 'block', 'the same change after a revert is new again');
});

test('stop docs: a new top-level directory is reminded once', () => {
  const dir = docsProject();
  edit(dir, 'tools/gen.mjs', 'export {}\n');
  assert.match(stop(dir).json.reason, /новый каталог tools\//);
  edit(dir, 'tools/more.mjs', 'export {}\n');
  assert.equal(stop(dir).stdout, '', 'later writes into it do not remind');
  edit(dir, 'scripts/x.sh', 'echo\n');
  const other = stop(dir);
  assert.match(other.json.reason, /новый каталог scripts\//, 'another new directory still reminds');
  assert.doesNotMatch(other.json.reason, /tools/);

  git(dir, 'add', 'tools');
  git(dir, 'commit', '-q', '-m', 'tools');
  edit(dir, 'tools/third.mjs', 'export {}\n');
  assert.equal(stop(dir).stdout, '');
  assert.ok(!(state(dir).docs.reminded?.dirs ?? []).includes('tools'), 'a committed directory is forgotten');
});

/** `git init` in an existing directory with a committed package.json. */
function nestedRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  configureRepo(dir);
  write(dir, 'package.json', PKG);
  git(dir, 'add', 'package.json');
  git(dir, 'commit', '-q', '-m', 'base');
}

test('stop docs: git is detected per package.json — no git at the root, repos in sub-folders', () => {
  const root = tempDir();
  write(root, 'AGENTS.md', '# Agents\n`app/` — app\n');
  write(root, 'CLAUDE.md', '@AGENTS.md\n');
  write(root, 'app/README.md', '# app\n');
  nestedRepo(join(root, 'app'));
  writeProfile(root, { verify: { on_stop: 'off' } });
  assert.equal(stop(root).stdout, '');
  edit(root, 'app/package.json', { ...PKG, dependencies: { a: '9.0.0' } });
  assert.equal(stop(root).stdout, '', 'scripts equal the sub-repo HEAD');
  edit(root, 'app/package.json', { ...PKG, scripts: { start: 'node .' } });
  const r = stop(root);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /app\/package\.json \(scripts\)/);
});

test('stop docs: a nested repo under a git parent compares with its own HEAD', () => {
  const dir = gitRepo('feature/x');
  write(dir, 'AGENTS.md', '# Agents\n`sub/` — nested repo\n');
  write(dir, 'CLAUDE.md', '@AGENTS.md\n');
  git(dir, 'add', 'AGENTS.md', 'CLAUDE.md');
  git(dir, 'commit', '-q', '-m', 'base');
  write(dir, 'sub/README.md', '# sub\n');
  nestedRepo(join(dir, 'sub'));
  writeProfile(dir, { verify: { on_stop: 'off' } });
  assert.equal(stop(dir).stdout, '');
  edit(dir, 'sub/package.json', { ...PKG, dependencies: { a: '9.0.0' } });
  assert.equal(stop(dir).stdout, '', 'not "new": the nested repo has it in HEAD');
  edit(dir, 'sub/package.json', { ...PKG, scripts: { start: 'node .' } });
  assert.match(stop(dir).json.reason, /sub\/package\.json \(scripts\)/);
});

test('stop docs: a negative cursor is read from the start and the verify message survives', () => {
  const dir = docsProject({ commands: { test: 'node -e ""' }, verify: { steps: ['test'], on_stop: 'full' } });
  edit(dir, 'package.json', { ...PKG, scripts: { x: 'y' } });
  const s = state(dir);
  s.docs.offset = -5;
  s.verify = { ok: false, summary: 'test: код 1', edits_offset: readFileSync(join(dir, '.forge', 'edits.jsonl')).length, notified: false };
  writeFileSync(join(dir, '.forge', 'state.json'), JSON.stringify(s));
  const r = stop(dir);
  assert.match(r.json.systemMessage, /последняя проверка не прошла/);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /package\.json \(scripts\)/);
  assert.equal(state(dir).docs.offset, readFileSync(join(dir, '.forge', 'edits.jsonl')).length);
});

test('stop docs: remind false drops the docs cursor so it no longer holds rotation', () => {
  const dir = docsProject();
  const log = join(dir, '.forge', 'edits.jsonl');
  writeFileSync(log, `${JSON.stringify({ t: 0, f: 'gone.txt' })}\n`.repeat(12000));
  const size = readFileSync(log).length;
  const s = state(dir);
  s.verify = { ok: true, summary: 'ok', edits_offset: size, notified: false };
  s.lint_offset = size;
  s.docs.offset = 10;
  writeFileSync(join(dir, '.forge', 'state.json'), JSON.stringify(s));
  writeProfile(dir, { verify: { on_stop: 'off' }, docs: { remind: false } });
  assert.equal(stop(dir).stdout, '');
  assert.equal(state(dir).docs, undefined, 'stale cursor dropped');
  assert.equal(readFileSync(log).length, 0, 'log rotated');
});

test('stop docs: a non-link CLAUDE.md closes a change, the link itself does not', () => {
  const dir = docsProject();
  edit(dir, '.github/workflows/ci.yml', 'on: push\n');
  edit(dir, 'CLAUDE.md', '@AGENTS.md\n\nCI lives in .github/workflows/ci.yml\n');
  assert.equal(stop(dir).stdout, '');

  const link = docsProject();
  edit(link, '.github/workflows/ci.yml', 'on: push\n');
  edit(link, 'CLAUDE.md', '@AGENTS.md\n');
  assert.equal(stop(link).json.decision, 'block');
});

test('stop docs: long lists are cut with «и ещё N» and the reason stays short', () => {
  const dir = docsProject();
  for (let i = 0; i < 25; i++) edit(dir, `.github/workflows/workflow-with-a-long-name-${i}.yml`, 'on: push\n');
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /и ещё \d+/);
  assert.ok(r.json.reason.length <= 600, `length ${r.json.reason.length}`);
});

const CHANGELOG_EMPTY = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] — 2026-01-01\n\n### Added\n\n- Первое.\n';
const CHANGELOG_FILLED = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Починено.\n\n## [0.1.0] — 2026-01-01\n\n### Added\n\n- Первое.\n';
const RELEASE_REASON = /forge: в этой задаче менялся код \(lib\/a\.mjs\), а в CHANGELOG\.md в \[Unreleased\] пусто\. Если изменение заметно/;

/**
 * A git project with a committed CHANGELOG.md and lib/a.mjs and a release section in the profile
 * (`release: null` — none). The first Stop is already done, so the window cursor exists.
 */
function releaseProject({ branch = 'feature/x', release = {}, docs, verify = { on_stop: 'off' }, commands, changelog = CHANGELOG_EMPTY, agents } = {}) {
  const dir = gitRepo(branch);
  if (changelog !== null) write(dir, 'CHANGELOG.md', changelog);
  write(dir, 'lib/a.mjs', 'export {}\n');
  if (agents) {
    write(dir, 'AGENTS.md', agents);
    write(dir, 'package.json', PKG);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  writeProfile(dir, { verify, ...(release ? { release } : {}), ...(docs ? { docs } : {}), ...(commands ? { commands } : {}) });
  assert.equal(stop(dir).stdout, '', 'first stop only sets the cursor');
  return dir;
}

const logSize = (dir) => (existsSync(join(dir, '.forge', 'edits.jsonl')) ? readFileSync(join(dir, '.forge', 'edits.jsonl')).length : 0);

test('stop release: code changed and [Unreleased] empty → one reminder per branch', () => {
  const dir = releaseProject();
  edit(dir, 'lib/a.mjs', 'export const a = 1;\n');
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /^forge: /);
  assert.match(r.json.reason, RELEASE_REASON);
  assert.match(r.json.reason, /так и скажи и заверши работу\.$/);
  assert.ok(r.json.reason.length <= 400, `length ${r.json.reason.length}`);
  assert.deepEqual(state(dir).release.reminded, ['feature/x']);
  assert.equal(state(dir).docs.offset, logSize(dir), 'one cursor, at the end of the log');

  assert.equal(stop(dir, { stop_hook_active: true }).stdout, '', 'no new edits → nothing');
  edit(dir, 'lib/b.mjs', 'export {}\n');
  assert.equal(stop(dir).stdout, '', 'the branch was already reminded');
});

test('stop release: silent when [Unreleased] has an entry or only ignored files changed', () => {
  const filled = releaseProject({ changelog: CHANGELOG_FILLED });
  edit(filled, 'lib/a.mjs', 'export const a = 1;\n');
  assert.equal(stop(filled).stdout, '');

  const ignored = releaseProject({ release: { ignore: ['scripts/**'] } });
  edit(ignored, 'test/a.test.mjs', 'x\n');
  edit(ignored, 'src/__tests__/b.js', 'x\n');
  edit(ignored, 'lib/a.spec.mjs', 'x\n');
  edit(ignored, 'docs/guide.md', 'x\n');
  edit(ignored, 'README.md', 'x\n');
  edit(ignored, 'pkg/notes.md', 'x\n');
  edit(ignored, 'scripts/gen.sh', 'x\n');
  edit(ignored, 'CHANGELOG.md', CHANGELOG_EMPTY.replace('Первое', 'Первая версия'));
  assert.equal(stop(ignored).stdout, '', 'tests, docs, *.md, profile ignore and the changelog itself do not count');
  assert.equal(state(ignored).release, undefined, 'nothing remembered');

  const filledNow = releaseProject();
  edit(filledNow, 'lib/a.mjs', 'export const a = 1;\n');
  edit(filledNow, 'CHANGELOG.md', CHANGELOG_FILLED);
  assert.equal(stop(filledNow).stdout, '', 'an entry written in the same window');

  const missing = releaseProject({ changelog: null });
  edit(missing, 'lib/a.mjs', 'export const a = 1;\n');
  assert.equal(stop(missing).stdout, '', 'no changelog is forge release --check\'s business');
});

test('stop release: silent without a release section or with remind false', () => {
  const none = releaseProject({ release: null });
  edit(none, 'lib/a.mjs', 'export const a = 1;\n');
  assert.equal(stop(none).stdout, '');

  const off = releaseProject({ release: { remind: false } });
  edit(off, 'lib/a.mjs', 'export const a = 1;\n');
  assert.equal(stop(off).stdout, '');
  assert.equal(state(off).release, undefined);
});

test('stop release: on the default branch — once until the next version tag', () => {
  const dir = releaseProject({ branch: 'main' });
  edit(dir, 'lib/a.mjs', 'export const a = 1;\n');
  assert.match(stop(dir).json.reason, RELEASE_REASON);
  assert.deepEqual(state(dir).release.reminded, ['main@none']);
  edit(dir, 'lib/a.mjs', 'export const a = 2;\n');
  assert.equal(stop(dir).stdout, '', 'same tag → quiet');

  git(dir, 'tag', 'not-a-version');
  edit(dir, 'lib/a.mjs', 'export const a = 3;\n');
  assert.equal(stop(dir).stdout, '', 'a non-version tag changes nothing');

  git(dir, 'tag', 'v0.1.0');
  edit(dir, 'lib/a.mjs', 'export const a = 4;\n');
  assert.match(stop(dir).json.reason, RELEASE_REASON, 'a new version tag → once again');
  assert.deepEqual(state(dir).release.reminded, ['main@none', 'main@v0.1.0']);
  edit(dir, 'lib/a.mjs', 'export const a = 5;\n');
  assert.equal(stop(dir).stdout, '');

  // origin/HEAD names the default branch: "trunk" is default, "main" is then an ordinary branch
  const trunk = releaseProject({ branch: 'trunk' });
  git(trunk, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  git(trunk, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  edit(trunk, 'lib/a.mjs', 'export const a = 1;\n');
  assert.match(stop(trunk).json.reason, RELEASE_REASON);
  git(trunk, 'checkout', '-q', '-b', 'main');
  edit(trunk, 'lib/a.mjs', 'export const a = 2;\n');
  assert.match(stop(trunk).json.reason, RELEASE_REASON);
  assert.deepEqual(state(trunk).release.reminded, ['trunk@none', 'main']);
});

test('stop release: a long file list is cut with «и ещё N», the reason stays under 400 chars', () => {
  const dir = releaseProject({ release: { changelog: 'docs/CHANGES.md' }, changelog: null });
  write(dir, 'docs/CHANGES.md', CHANGELOG_EMPTY);
  for (let i = 0; i < 25; i++) edit(dir, `src/module-with-a-rather-long-name-${i}.mjs`, 'export {}\n');
  const r = stop(dir);
  assert.match(r.json.reason, /и ещё \d+\), а в docs\/CHANGES\.md в \[Unreleased\] пусто/);
  assert.ok(r.json.reason.length <= 400, `length ${r.json.reason.length}`);
});

test('stop release: the remembered keys are capped at the most recent 20', () => {
  const dir = releaseProject();
  const s = state(dir);
  s.release = { reminded: Array.from({ length: 20 }, (_, i) => `old-${i}`) };
  writeFileSync(join(dir, '.forge', 'state.json'), JSON.stringify(s));
  edit(dir, 'lib/a.mjs', 'export const a = 1;\n');
  assert.equal(stop(dir).json.decision, 'block');
  const kept = state(dir).release.reminded;
  assert.equal(kept.length, 20);
  assert.equal(kept[0], 'old-1');
  assert.equal(kept.at(-1), 'feature/x');
});

test('stop release: with the agent-docs reminder — one block with both reasons', () => {
  const dir = releaseProject({ agents: '# Agents\n' });
  edit(dir, 'package.json', { ...PKG, scripts: { build: 'tsc' } });
  edit(dir, 'lib/a.mjs', 'export const a = 1;\n');
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  const [docs, release, ...rest] = r.json.reason.split('\n\n');
  assert.match(docs, /^forge: в этой задаче изменились команды или структура: package\.json \(scripts\)/);
  assert.match(release, /^forge: в этой задаче менялся код \(package\.json, lib\/a\.mjs\)/);
  assert.deepEqual(rest, []);
  assert.deepEqual(state(dir).release.reminded, ['feature/x']);
  assert.equal(stop(dir).stdout, '');

  // only one of them fires → only its reason, and only its memory changes
  const docsOnly = releaseProject({ agents: '# Agents\n', changelog: CHANGELOG_FILLED });
  edit(docsOnly, 'package.json', { ...PKG, scripts: { build: 'tsc' } });
  const d = stop(docsOnly);
  assert.doesNotMatch(d.json.reason, /CHANGELOG/);
  assert.equal(state(docsOnly).release, undefined);
});

test('stop release: an error in one reminder is logged, the other still speaks', () => {
  const dir = releaseProject({ agents: '# Agents\n', changelog: null });
  write(dir, 'CHANGELOG.md/x', 'a directory where the changelog should be');
  edit(dir, 'package.json', { ...PKG, scripts: { build: 'tsc' } });
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /package\.json \(scripts\)/);
  assert.doesNotMatch(r.json.reason, /\[Unreleased\]/);
  assert.match(readFileSync(join(dir, '.forge', 'log', 'errors.log'), 'utf8'), /\[stop:release\]/);
  assert.equal(state(dir).docs.offset, logSize(dir));
});

test('stop release: a failing check wins and giving up stays silent; the reminder comes after a pass', () => {
  const dir = releaseProject({ commands: { test: 'node check.mjs' }, verify: { steps: ['test'], on_stop: 'full' } });
  write(dir, 'check.mjs', "import { readFileSync } from 'node:fs';\nif (readFileSync('status.txt','utf8').trim() !== 'ok') { console.error('check failed'); process.exit(1); }\n");
  write(dir, 'status.txt', 'fail');
  edit(dir, 'lib/a.mjs', 'export const a = 1;\n');
  const cursor = state(dir).docs.offset;
  const blocked = stop(dir);
  assert.equal(blocked.json.decision, 'block');
  assert.match(blocked.json.reason, /проверка перед завершением не прошла/);
  assert.doesNotMatch(blocked.json.reason, /Unreleased/);
  edit(dir, 'lib/a.mjs', 'export const a = 2;\n');
  assert.doesNotMatch(stop(dir, { stop_hook_active: true }).json.reason, /Unreleased/);
  edit(dir, 'lib/a.mjs', 'export const a = 3;\n');
  const gaveUp = stop(dir, { stop_hook_active: true });
  assert.match(gaveUp.json.systemMessage, /3 раз\(а\) подряд/);
  assert.equal(gaveUp.json.decision, undefined);
  assert.equal(state(dir).docs.offset, cursor, 'window cursor untouched');
  assert.equal(state(dir).release, undefined, 'nothing remembered');

  edit(dir, 'status.txt', 'ok');
  const r = stop(dir);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /^forge: в этой задаче менялся код \(lib\/a\.mjs, status\.txt\), а в CHANGELOG\.md в \[Unreleased\] пусто/);
});

test('stop release: one window cursor survives "docs off, release on" and "release off, docs on"', () => {
  const dir = releaseProject({ agents: '# Agents\n', docs: { remind: false } });
  assert.equal(state(dir).docs.offset, logSize(dir), 'docs off, release on: the cursor exists');
  edit(dir, 'package.json', { ...PKG, scripts: { build: 'tsc' } });
  edit(dir, 'lib/a.mjs', 'export const a = 1;\n');
  const r = stop(dir);
  assert.match(r.json.reason, /^forge: в этой задаче менялся код/);
  assert.doesNotMatch(r.json.reason, /команды или структура/);
  assert.equal(state(dir).docs.offset, logSize(dir));

  writeProfile(dir, { verify: { on_stop: 'off' }, release: { remind: false } });
  assert.equal(stop(dir).stdout, '', 'the window was consumed: nothing is re-read from the start');
  assert.equal(state(dir).docs.offset, logSize(dir), 'release off, docs on: the cursor stays');
  edit(dir, 'package.json', { ...PKG, scripts: { build: 'tsc', lint: 'eslint .' } });
  const d = stop(dir);
  assert.match(d.json.reason, /package\.json \(scripts\)/);
  assert.doesNotMatch(d.json.reason, /Unreleased/);

  writeProfile(dir, { verify: { on_stop: 'off' }, docs: { remind: false }, release: { remind: false } });
  assert.equal(stop(dir).stdout, '');
  assert.equal(state(dir).docs, undefined, 'both off: the cursor is dropped');

  // a stale cursor with only the release reminder on still lets a caught-up log rotate
  const rot = releaseProject({ docs: { remind: false } });
  const log = join(rot, '.forge', 'edits.jsonl');
  writeFileSync(log, `${JSON.stringify({ t: 0, f: 'gone.txt' })}\n`.repeat(12000));
  const size = logSize(rot);
  const s = state(rot);
  s.verify = { ok: true, summary: 'ok', edits_offset: size, notified: false };
  s.lint_offset = size;
  s.docs.offset = size;
  writeFileSync(join(rot, '.forge', 'state.json'), JSON.stringify(s));
  assert.equal(stop(rot).stdout, '');
  assert.equal(logSize(rot), 0, 'log rotated');
  assert.equal(state(rot).docs.offset, 0);
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
