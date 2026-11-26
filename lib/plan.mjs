// Reads a forge plan (the path from state.artifacts.plan, wherever profile `work` puts it) just enough to say
// where the work stands: which tasks are checked and which one comes next. Cheap and fail-open:
// SessionStart calls it, so a missing, huge or unreadable plan yields null, never an exception.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_PLAN_BYTES = 256 * 1024;
const TASK_RE = /^[-*]\s+\[([ xX])\]\s+(T\d[\w-]*)[:.]?(?:\s+(.*))?$/;
const DEPENDS_RE = /^\s+depends:\s*(.*)$/i;

/** Tasks of a plan in file order: `{ id, title, done, depends: [ids] }`. Fenced code blocks are skipped. */
export function parsePlan(text) {
  const tasks = [];
  let fenced = false;
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      current = null;
      continue;
    }
    if (fenced) continue;
    const task = TASK_RE.exec(line);
    if (task) {
      current = { id: task[2], title: (task[3] || '').trim(), done: task[1] !== ' ', depends: [] };
      tasks.push(current);
      continue;
    }
    const deps = current && DEPENDS_RE.exec(line);
    if (deps) current.depends = deps[1].split(/[\s,]+/).filter((d) => d && d !== '-');
    else if (line.trim() && !/^\s/.test(line)) current = null; // a top-level line ends the task's block
  }
  return tasks;
}

/** The first unchecked task whose dependencies are all checked; otherwise the first unchecked one; else null. */
export function nextTask(tasks) {
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  const open = tasks.filter((t) => !t.done);
  return open.find((t) => t.depends.every((d) => done.has(d))) || open[0] || null;
}

/** `{ total, done, next }` for the plan at `planPath` (relative to `root` or absolute), or null. */
export function planProgress(root, planPath) {
  if (typeof planPath !== 'string' || !planPath) return null;
  try {
    const file = resolve(root, planPath);
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_PLAN_BYTES) return null;
    const tasks = parsePlan(readFileSync(file, 'utf8'));
    if (!tasks.length) return null;
    return { total: tasks.length, done: tasks.filter((t) => t.done).length, next: nextTask(tasks) };
  } catch {
    return null;
  }
}
