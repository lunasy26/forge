import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
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
 * 2. nearest ancestor of cwd that has .forge/profile.json
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
    const parent = dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return gitToplevel(start) || start;
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
