import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function currentBranch(cwd) {
  return git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
}

export function isGitRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** origin's default branch name, if known (e.g. "main"). */
export function defaultBranch(cwd) {
  const ref = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  return ref ? ref.replace(/^refs\/remotes\/origin\//, '') : null;
}

/** Add lines to .git/info/exclude (shared by all worktrees) without touching .gitignore. */
export function addExcludes(cwd, lines) {
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return [];
  const dir = isAbsolute(common) ? common : resolve(cwd, common);
  const file = join(dir, 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${prefix}# forge\n${missing.join('\n')}\n`);
  }
  return missing;
}

export function excludedLines(cwd) {
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  const file = join(isAbsolute(common) ? common : resolve(cwd, common), 'info', 'exclude');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((l) => l.trim()) : [];
}
