import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const FORGE_DIR = '.forge';

/** Root of the plugin itself (where config/, agents/, skills/ live). */
export function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT && existsSync(process.env.CLAUDE_PLUGIN_ROOT)) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function gitToplevel(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Project root resolution order:
 * 1. CLAUDE_PROJECT_DIR (set by Claude Code for hooks)
 * 2. nearest ancestor of cwd that has .forge/profile.json, not above the first directory with .git
 *    (a file or a directory): a worktree nested in the main checkout (.claude/worktrees/x) is its
 *    own project, not the main checkout's
 * 3. git toplevel
 * 4. cwd
 */
export function projectRoot(cwd = process.cwd()) {
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (envDir && isDir(envDir)) return resolve(envDir);
  const start = resolve(cwd || process.cwd());
  const home = homedir();
  let dir = start;
  while (true) {
    if (existsSync(join(dir, FORGE_DIR, 'profile.json'))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return gitToplevel(start) || start;
}

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** First "worktree" entry of `git worktree list --porcelain`, unless it is bare. */
function firstListedWorktree(root) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const [first = ''] = r.stdout.split(/\n\s*\n/);
  const lines = first.split('\n');
  if (lines.includes('bare')) return null;
  const line = lines.find((l) => l.startsWith('worktree '));
  return line ? line.slice('worktree '.length) : null;
}

/**
 * Main checkout of the linked git worktree whose top is root, or null (a normal checkout, a
 * submodule, a main checkout with a separate git dir, not a repo). Reads files instead of running
 * git: root/.git is a "gitdir: …" file, and a linked worktree's gitdir has a commondir file; when
 * the common dir is named .git, the main checkout is its parent. Only unusual layouts (a bare
 * repository, a separate git dir) ask git. Never throws.
 */
export function mainWorktree(root) {
  try {
    const dotGit = join(root, '.git');
    if (!statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitDir = resolve(root, m[1]);
    const commondirFile = join(gitDir, 'commondir');
    if (!existsSync(commondirFile)) return null;
    const common = resolve(gitDir, readFileSync(commondirFile, 'utf8').trim());
    const main = basename(common) === '.git' ? dirname(common) : firstListedWorktree(root);
    if (!main || !isDir(main) || realOrSelf(main) === realOrSelf(root)) return null;
    return main;
  } catch {
    return null;
  }
}

export function forgePath(root, ...parts) {
  return join(root, FORGE_DIR, ...parts);
}

/** Path relative to root with forward slashes; paths outside root keep their absolute form without the leading slash. */
export function relToRoot(root, file) {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, abs);
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  return abs.split(sep).join('/').replace(/^\/+/, '');
}

export function isInside(root, abs) {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
