import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { emptyConfigDir, gitRepo, PLUGIN_ROOT, runCli, writeProfile } from './helpers.mjs';

// A reader that closes the pipe early (`forge doctor | head -3`) must end the output quietly: no stack in
// stderr, the command's own exit code. The parent closes its end of the child's stdout either right after
// spawning (the first write is certain to hit a closed pipe) or after the first line (the case from the
// shell). Windows pipes report the same condition as EPIPE or EOF; both are covered by the fix.

function spawnClosing(script, args, { closeAt, env, cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: emptyConfigDir(), FORGE_LANG: 'ru', ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const close = () => child.stdout.destroy();
    if (closeAt === 'start') close();
    else
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.includes('\n')) close();
      });
    child.stderr.on('data', (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function project() {
  const dir = gitRepo();
  writeProfile(dir, { commands: { test: 'node -e ""' } });
  return dir;
}

for (const args of [['doctor'], ['route', '--table']]) {
  for (const closeAt of ['start', 'first line']) {
    test(`cli: ${args.join(' ')} with stdout closed at ${closeAt} ends quietly`, async () => {
      const dir = project();
      const expected = runCli(args, { cwd: dir, env: { FORGE_LANG: 'ru' } }).code;
      const bin = join(PLUGIN_ROOT, 'bin', 'forge');
      const r = await spawnClosing(bin, args, { closeAt, cwd: dir, env: { CLAUDE_PROJECT_DIR: '' } });
      assert.equal(r.signal, null);
      assert.doesNotMatch(r.stderr, /EPIPE|EOF|Unhandled 'error'|\n\s+at /, r.stderr);
      assert.equal(r.code, expected, r.stderr);
    });
  }
}

// Hooks write once and call process.exit(0) right after it, so the write error is never delivered.
// This pins that: a hook whose stdout is already closed still exits 0 without a stack.
test('hooks: a guard verdict written to a closed stdout ends quietly', async () => {
  const dir = gitRepo();
  const r = await spawnClosing(join(PLUGIN_ROOT, 'hooks', 'pre-bash.mjs'), [], {
    closeAt: 'start',
    cwd: dir,
    env: { CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    input: JSON.stringify({ cwd: dir, tool_input: { command: 'git push --force origin main' } }),
  });
  assert.equal(r.signal, null);
  assert.equal(r.stderr, '');
  assert.equal(r.code, 0);
});
