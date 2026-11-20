import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, truncateSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { forgePath, relToRoot } from './paths.mjs';

/**
 * Edits are an append-only JSONL log (.forge/edits.jsonl), so parallel PostToolUse hooks
 * never race on state.json. Consumers keep a byte offset ("cursor") into the log.
 */
export function editsPath(root) {
  return forgePath(root, 'edits.jsonl');
}

export function recordEdit(root, file) {
  const path = editsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ t: Date.now(), f: relToRoot(root, file) }) + '\n');
}

export function editsSize(root) {
  try {
    return statSync(editsPath(root)).size;
  } catch {
    return 0;
  }
}

/** Unique, still-existing files edited after `offset` (inside the project only). */
export function filesSince(root, offset = 0) {
  const path = editsPath(root);
  if (!existsSync(path)) return [];
  const size = editsSize(root);
  if (offset >= size) return [];
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(size - offset);
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const files = new Set();
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const { f } = JSON.parse(line);
      if (typeof f === 'string' && !f.startsWith('..')) files.add(f);
    } catch {
      // skip a torn line
    }
  }
  return [...files].filter((f) => existsSync(resolve(root, f)));
}

/** Truncate the log once every consumer has caught up and it has grown large. */
export function maybeRotate(root, offsets, limit = 256 * 1024) {
  const size = editsSize(root);
  if (size < limit || offsets.some((o) => (o ?? 0) < size)) return false;
  truncateSync(editsPath(root), 0);
  return true;
}
