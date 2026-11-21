import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { forgePath, projectRoot } from './paths.mjs';
import { defineCatalog, t } from './i18n.mjs';

const MSG = defineCatalog({
  en: { hidden: '… ({n} lines hidden)' },
  ru: { hidden: '… (скрыто строк: {n})' },
});

export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Where errors go: <project>/.forge/log if the project uses forge, otherwise the system temp dir. */
export function errorLogPath(root) {
  if (root && existsSync(forgePath(root))) return forgePath(root, 'log', 'errors.log');
  return join(tmpdir(), 'forge-errors.log');
}

export function logError(root, where, err) {
  try {
    const file = errorLogPath(root);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} [${where}] ${err?.stack || err}\n`);
  } catch {
    // never let logging break a hook
  }
}

/**
 * Hook runner: reads stdin JSON, runs fn(input, root), prints the returned object as JSON.
 * Fail-open: any internal error is logged and the hook exits 0 with no output.
 */
export async function runHook(name, fn) {
  let root = null;
  try {
    const input = await readStdinJson();
    root = projectRoot(input.cwd);
    const out = await fn(input, root);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    logError(root, name, err);
  }
  process.exit(0);
}

export function shellQuote(s) {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Keep the head and tail of long output: errors are usually at one of the ends. */
export function trimOutput(text, maxLines = 60) {
  const lines = stripAnsi(text).replace(/\s+$/, '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  const head = 10;
  const tail = maxLines - head - 1;
  const hidden = lines.length - head - tail;
  return [...lines.slice(0, head), t(MSG, 'hidden', { n: hidden }), ...lines.slice(-tail)].join('\n');
}
