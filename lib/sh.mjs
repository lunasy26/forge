import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { defineCatalog, t } from './i18n.mjs';

const MSG = defineCatalog({
  en: {
    shellMissing: 'forge: Git Bash not found — install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH',
    gitBashOk: 'Git Bash: {path}',
    gitBashMissing: 'Git Bash not found — install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH',
  },
  ru: {
    shellMissing: 'forge: Git Bash не найден — установи Git for Windows или задай CLAUDE_CODE_GIT_BASH_PATH',
    gitBashOk: 'Git Bash: {path}',
    gitBashMissing: 'Git Bash не найден — установи Git for Windows или задай CLAUDE_CODE_GIT_BASH_PATH',
  },
});

/** `git --exec-path` or null; looks like `C:/Program Files/Git/mingw64/libexec/git-core` on Windows. */
function defaultGitExecPath() {
  try {
    const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 5000 });
    const out = r.status === 0 ? String(r.stdout || '').trim() : '';
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Absolute path of the shell that runs profile commands, or null when there is none.
 * POSIX: /bin/sh. win32: Git Bash — CLAUDE_CODE_GIT_BASH_PATH, then the Git next to
 * `git --exec-path`, then the usual install locations. Pure: everything is injectable.
 */
export function resolveShell({ platform = process.platform, env = process.env, exists = existsSync, gitExecPath = defaultGitExecPath } = {}) {
  if (platform !== 'win32') return '/bin/sh';
  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && exists(override)) return override;
  const exec = gitExecPath();
  if (exec) {
    // <git>/mingw64/libexec/git-core -> <git>
    const root = win32.dirname(win32.dirname(win32.dirname(win32.normalize(exec))));
    const bash = win32.join(root, 'bin', 'bash.exe');
    if (exists(bash)) return bash;
  }
  const bases = [
    [env.ProgramFiles, 'Git'],
    [env['ProgramFiles(x86)'], 'Git'],
    [env.LOCALAPPDATA, 'Programs', 'Git'],
  ];
  for (const [base, ...rest] of bases) {
    if (!base) continue;
    const bash = win32.join(base, ...rest, 'bin', 'bash.exe');
    if (exists(bash)) return bash;
  }
  return null;
}

let cached;

/** `resolveShell()` with the real environment, computed once per process. */
export function shellPath() {
  if (cached === undefined) cached = resolveShell();
  return cached;
}

/** Message for a profile command that cannot run: no shell found (win32 without Git Bash). */
export function shellMissingMessage() {
  return t(MSG, 'shellMissing');
}

/** The `forge doctor` Git Bash line as { ok, text }; null off Windows. */
export function doctorShellLine({ platform = process.platform, shell } = {}) {
  if (platform !== 'win32') return null;
  const path = shell === undefined ? shellPath() : shell;
  return path ? { ok: true, text: t(MSG, 'gitBashOk', { path }) } : { ok: false, text: t(MSG, 'gitBashMissing') };
}
