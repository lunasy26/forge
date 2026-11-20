import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { isGitRepo } from './git.mjs';
import { DEFAULT_DOCS_WATCH, commandSpec } from './profile.mjs';

export { DEFAULT_DOCS_WATCH };

const AGENTS = 'AGENTS.md';
const CLAUDE = 'CLAUDE.md';
const IMPORT_LINE = '@AGENTS.md';
const SHIM = `${IMPORT_LINE}\n`;

export const SCAN_ENTRY_LIMIT = 20000;
export const SCAN_MAX_DEPTH = 6;
export const FAT_CLAUDE_LINES = 30;

/** Directories the non-git walk never enters (hidden directories are skipped too). */
const SKIP_DIRS = new Set([
  '.git', '.forge', 'node_modules', 'vendor', 'dist', 'build', 'target', 'bin', 'obj',
  '.venv', 'venv', '__pycache__', 'Pods', 'DerivedData',
]);

function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Lines of text that are not inside a fenced code block. */
function proseLines(text) {
  const out = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) out.push(line);
  }
  return out;
}

/** True when a line outside code blocks is exactly "@AGENTS.md" (spaces around it are fine). */
export function hasImport(text) {
  return proseLines(text).some((l) => l.trim() === IMPORT_LINE);
}

/** A CLAUDE.md that is exactly "@AGENTS.md" and an optional line break. */
export function isShim(text) {
  return /^@AGENTS\.md\r?\n?$/.test(text);
}

function walk(root, limit) {
  const files = [];
  let entries = 0;
  let complete = true;
  const visit = (rel, depth) => {
    let items;
    try {
      items = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (!complete) return;
      if (++entries > limit) {
        complete = false;
        return;
      }
      const path = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (depth < SCAN_MAX_DEPTH && !SKIP_DIRS.has(item.name) && !item.name.startsWith('.')) visit(path, depth + 1);
      } else if ((item.name === AGENTS || item.name === CLAUDE) && item.isFile()) {
        files.push(path);
      }
    }
  };
  visit('', 0);
  return { files, complete };
}

function gitList(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * All AGENTS.md / CLAUDE.md files of the project, relative to root, sorted.
 * In a git repository uses `git ls-files` (tracked and untracked, minus ignored);
 * otherwise walks directories with a skip list, depth 6 and at most `limit` entries.
 * `complete` is false when the walk was cut short.
 */
export function findAgentFiles(root, limit = SCAN_ENTRY_LIMIT) {
  let result = null;
  if (isGitRepo(root)) {
    const listed = gitList(root);
    if (listed) {
      const files = listed.filter((p) => {
        const name = p.slice(p.lastIndexOf('/') + 1);
        return (name === AGENTS || name === CLAUDE) && isFile(join(root, p));
      });
      result = { files, complete: true };
    }
  }
  if (!result) result = walk(root, limit);
  result.files = [...new Set(result.files)].sort();
  return result;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join2 = (dir, name) => (dir ? `${dir}/${name}` : name);

function nonEmptyLines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '');
}

function lineCount(text) {
  if (text === '') return 0;
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First one or two words of a verify command: "npm test -- {files}" → "npm test", "pytest -q" → "pytest". */
function commandKey(run) {
  const cut = run.includes('{') ? run.slice(0, run.indexOf('{')) : run;
  const words = cut.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length > 1 && !words[1].startsWith('-')) return `${words[0]} ${words[1]}`;
  return words[0];
}

/** Does `text` mention directory `dir` as "dir/", "dir/AGENTS.md" or "`dir`" (not as the tail of a longer path)? */
function mentionsDir(text, dir) {
  const p = escapeRe(dir);
  const clean = text.replace(/(^|[^\w.\-/])\.\//g, '$1');
  const before = '(?<![\\w.\\-/])';
  return new RegExp(`${before}${p}/|\`${p}\``).test(clean);
}

function markdownLinks(text) {
  const prose = proseLines(text).join('\n').replace(/`[^`\n]*`/g, '');
  const out = [];
  const re = /\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const m of prose.matchAll(re)) out.push(m[1].replace(/^<|>$/g, ''));
  return out;
}

function brokenTarget(root, fileDir, target) {
  if (!target || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  let path = target.replace(/[#?].*$/, '');
  if (!path) return null;
  try {
    path = decodeURIComponent(path);
  } catch { /* keep raw */ }
  const abs = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(root, fileDir, path);
  return existsSync(abs) ? null : path;
}

/**
 * Deterministic structure check of the project's agent files.
 * Issue = { code, level: 'error' | 'warn', path, message, fixable }.
 * `options.limit` lowers the walk's entry limit (tests).
 */
export function checkDocs(root, profile, { limit = SCAN_ENTRY_LIMIT } = {}) {
  const issues = [];
  const add = (code, level, path, message, fixable = false) => issues.push({ code, level, path, message, fixable });
  const docs = profile?.docs ?? {};
  const maxLines = Number.isInteger(docs.max_lines) && docs.max_lines > 0 ? docs.max_lines : 200;

  const { files, complete } = findAgentFiles(root, limit);
  const fileSet = new Set(files);
  const texts = new Map(files.map((f) => [f, readText(join(root, f))]));
  const dirs = [...new Set(files.map(dirOf))].sort();
  const hasAgents = (d) => fileSet.has(join2(d, AGENTS));
  const hasClaude = (d) => fileSet.has(join2(d, CLAUDE));
  /** The agent file of a directory: AGENTS.md, else CLAUDE.md. */
  const agentFile = (d) => (hasAgents(d) ? join2(d, AGENTS) : hasClaude(d) ? join2(d, CLAUDE) : null);

  if (!complete) {
    add('incomplete-scan', 'warn', '.',
      `обход каталогов оборвался на ${limit} записях — часть агентских файлов могла не попасть в проверку`);
  }

  if (!hasAgents('')) {
    const rootClaude = texts.get(CLAUDE) ?? '';
    const hasContent = rootClaude.trim() !== '' && !isShim(rootClaude);
    add('missing-root', 'error', AGENTS, hasContent
      ? 'нет корневого AGENTS.md, а CLAUDE.md в корне с содержимым — перенеси его в AGENTS.md (/forge:docs)'
      : 'нет корневого AGENTS.md — /forge:docs поможет завести');
  }

  for (const dir of dirs) {
    const agentsPath = join2(dir, AGENTS);
    const claudePath = join2(dir, CLAUDE);
    const claudeText = texts.get(claudePath);

    if (hasAgents(dir) && !hasClaude(dir)) {
      add('missing-shim', 'error', claudePath, `рядом с ${agentsPath} нет ${claudePath} — forge docs --fix создаст ссылку @AGENTS.md`, true);
    }
    if (hasAgents(dir) && hasClaude(dir) && !hasImport(claudeText)) {
      const empty = claudeText.trim() === '';
      add('no-import', 'error', claudePath, empty
        ? `${claudePath} пуст и не подключает AGENTS.md — forge docs --fix заменит его ссылкой @AGENTS.md`
        : `${claudePath} не подключает AGENTS.md: добавь строку @AGENTS.md`, empty);
    }
    if (dir !== '' && hasClaude(dir) && !hasAgents(dir) && claudeText.trim() !== '') {
      add('claude-only', 'warn', claudePath, `${claudePath} с содержимым, а AGENTS.md рядом нет — перенеси текст в ${agentsPath} (/forge:docs)`);
    }
    if (hasClaude(dir)) {
      const count = nonEmptyLines(claudeText).filter((l) => l.trim() !== IMPORT_LINE).length;
      if (count > FAT_CLAUDE_LINES) {
        add('fat-claude', 'warn', claudePath, `в ${claudePath} ${count} непустых строк кроме импорта (больше ${FAT_CLAUDE_LINES}) — общее держи в AGENTS.md`);
      }
    }

    const agent = agentFile(dir);
    if (agent) {
      const n = lineCount(texts.get(agent));
      if (n > maxLines) add('too-long', 'warn', agent, `${agent}: ${n} строк при пределе ${maxLines} — раздели по областям (/forge:docs)`);

      const seen = new Set();
      for (const target of markdownLinks(texts.get(agent))) {
        const missing = brokenTarget(root, dir, target);
        if (missing && !seen.has(missing)) {
          seen.add(missing);
          add('broken-link', 'warn', agent, `${agent}: ссылка ведёт в несуществующий путь ${missing}`);
        }
      }
    }

    if (dir !== '' && hasAgents(dir)) {
      let ancestor = dirOf(dir);
      while (ancestor !== '' && !agentFile(ancestor)) ancestor = dirOf(ancestor);
      const holder = agentFile(ancestor);
      if (holder) {
        const fromRoot = dir;
        const fromAncestor = ancestor ? dir.slice(ancestor.length + 1) : dir;
        const text = texts.get(holder);
        if (!mentionsDir(text, fromRoot) && !mentionsDir(text, fromAncestor)) {
          add('unlisted', 'warn', agentsPath, `${holder} не упоминает ${dir}/ — добавь строку в таблицу областей`);
        }
      }
    }
  }

  const agentTexts = dirs.map(agentFile).filter(Boolean).map((f) => texts.get(f));
  if (agentTexts.length) {
    const corpus = agentTexts.join('\n');
    const reported = new Set();
    for (const step of profile?.verify?.steps ?? []) {
      const spec = commandSpec(profile.commands?.[step]);
      const key = spec ? commandKey(spec.run) : null;
      if (!key || reported.has(key) || corpus.includes(key)) continue;
      reported.add(key);
      add('verify-undocumented', 'warn', agentFile('') ?? files[0],
        `команда проверки "${key}" (шаг ${step}) не упомянута ни в одном агентском файле`);
    }
  }

  return issues;
}

/**
 * Create the one-line CLAUDE.md links that checkDocs marked fixable. Never writes anything else:
 * a missing file gets "@AGENTS.md\n", an empty one is replaced by it. Returns the paths written.
 */
export function fixDocs(root, issues) {
  const written = [];
  for (const issue of issues) {
    if (!issue.fixable) continue;
    const abs = resolve(root, issue.path);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || posix.basename(issue.path) !== CLAUDE) continue;
    if (issue.code === 'missing-shim') {
      try {
        writeFileSync(abs, SHIM, { flag: 'wx' });
        written.push(issue.path);
      } catch { /* exists or unwritable: leave it */ }
    } else if (issue.code === 'no-import') {
      if (isFile(abs) && readText(abs).trim() === '') {
        writeFileSync(abs, SHIM);
        written.push(issue.path);
      }
    }
  }
  return written;
}

/**
 * Cheap check of the two root files (no directory walk), for session start:
 * 'missing' — no root AGENTS.md; 'no-import' — CLAUDE.md does not import it; otherwise 'ok'.
 */
export function rootDocStatus(root) {
  if (!isFile(join(root, AGENTS))) return 'missing';
  const claude = join(root, CLAUDE);
  if (isFile(claude) && !hasImport(readText(claude))) return 'no-import';
  return 'ok';
}
