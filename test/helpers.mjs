import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function tempDir(prefix = 'forge-test-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function gitRepo(branch = 'main') {
  const dir = tempDir();
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  // never touch the developer's signing setup or global hooks (an SSH signer can block waiting for approval)
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', '/dev/null');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

export function write(dir, rel, content) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

export function writeProfile(dir, profile) {
  return write(dir, '.forge/profile.json', { version: 1, ...profile });
}

/** An isolated Claude config dir so tests never read the developer's real settings. */
export function emptyConfigDir() {
  return tempDir('forge-config-');
}

export function runHookScript(name, input, { projectDir, configDir = emptyConfigDir(), env = {} } = {}) {
  const started = Date.now();
  const r = spawnSync('node', [join(PLUGIN_ROOT, 'hooks', `${name}.mjs`)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_CONFIG_DIR: configDir,
      ...env,
    },
  });
  return {
    code: r.status,
    ms: Date.now() - started,
    stdout: r.stdout,
    stderr: r.stderr,
    json: r.stdout.trim() ? JSON.parse(r.stdout) : null,
  };
}

export function runCli(args, { cwd, env = {} } = {}) {
  const r = spawnSync('node', [join(PLUGIN_ROOT, 'bin', 'forge'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_CONFIG_DIR: emptyConfigDir(), ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
