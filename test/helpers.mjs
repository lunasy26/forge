import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The system temp dir as it was before the isolation below: where a real forge keeps its shared error log. */
export const OUTER_TMPDIR = tmpdir();

// Every test process gets its own temp dir, removed on exit. os.tmpdir() reads TMPDIR on POSIX and
// TEMP/TMP on Windows on each call, and hooks and the CLI inherit process.env, so fixtures, the test
// process and its children agree on one temp dir, and a hook that logs outside a forge project writes
// forge-errors.log here instead of the developer's shared one (which `forge doctor` reports).
const isolatedTmp = realpathSync.native(mkdtempSync(join(OUTER_TMPDIR, 'forge-tests-')));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = isolatedTmp;
process.on('exit', () => {
  try {
    rmSync(isolatedTmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // a locked file on Windows must not fail the run
  }
});

export function tempDir(prefix = 'forge-test-') {
  // .native resolves Windows 8.3 short names (RUNNER~1) to the long form that git and the CLI print
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** A path as written into git config: forward slashes work everywhere, backslashes need escaping. */
export const gitPath = (p) => p.replace(/\\/g, '/');

let emptyHooksDir;
/** An empty directory for `core.hooksPath`: no hooks run (`/dev/null` does not exist on Windows). */
export function noHooksPath() {
  emptyHooksDir ??= gitPath(tempDir('forge-nohooks-'));
  return emptyHooksDir;
}

let symlinks;
/** Whether symlinks can be created here: always on POSIX, on Windows only with the privilege (or Developer Mode). */
export function canSymlink() {
  if (symlinks !== undefined) return symlinks;
  if (process.platform !== 'win32') return (symlinks = true);
  const dir = tempDir('forge-symlink-');
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync('target', join(dir, 'link'));
    symlinks = true;
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    symlinks = false;
  }
  return symlinks;
}
/** `skip` value for symlink tests: a reason string when symlinks are unavailable, false otherwise. */
export const symlinkSkip = () => (canSymlink() ? false : 'symlinks need privilege on Windows');

/** Isolate a test repository from the developer's signing setup, global hooks and line-ending conversion. */
export function configureRepo(dir) {
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  // never touch the developer's signing setup or global hooks (an SSH signer can block waiting for approval)
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', noHooksPath());
  git(dir, 'config', 'core.autocrlf', 'false'); // Git for Windows defaults to true: fixtures must stay LF
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function gitRepo(branch = 'main') {
  const dir = tempDir();
  git(dir, 'init', '-q', '-b', branch);
  configureRepo(dir);
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
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', `${name}.mjs`)], {
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
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'forge'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_CONFIG_DIR: emptyConfigDir(), ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
