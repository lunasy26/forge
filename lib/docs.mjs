import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isGitRepo } from './git.mjs';
import { defineCatalog, t } from './i18n.mjs';
import { matchList } from './glob.mjs';
import { DEFAULT_DOCS_MAX_LINES, DEFAULT_DOCS_WATCH, commandSpec } from './profile.mjs';

export { DEFAULT_DOCS_WATCH };

const MSG = defineCatalog({
  en: {
    incompleteScan: 'directory walk stopped at {limit} entries: some agent files may have been skipped',
    missingRootContent: 'no root AGENTS.md, and the root CLAUDE.md has content: move it into AGENTS.md (/forge:docs)',
    missingRoot: 'no root AGENTS.md: /forge:docs can create one',
    missingShim: 'no {claude} next to {agents}: forge docs --fix will create an @AGENTS.md link',
    noImportUnreadable: 'cannot read {claude}: check its permissions; Claude Code cannot read it either',
    noImportEmpty: '{claude} is empty and does not import AGENTS.md: forge docs --fix will replace it with an @AGENTS.md link',
    noImport: '{claude} does not import AGENTS.md: add the line @AGENTS.md',
    claudeOnly: '{claude} has content but there is no AGENTS.md next to it: move the text into {agents} (/forge:docs)',
    fatClaude: '{claude} has {count} non-empty lines besides the import (limit {max}): keep shared content in AGENTS.md',
    tooLong: '{agent}: {n} lines, limit {max}: split it by area (/forge:docs)',
    brokenLink: '{agent}: link points to a missing path {missing}',
    unlisted: '{holder} does not mention {dir}/: add a row to the areas table',
    verifyUndocumented: 'verify command "{key}" (step {step}) is not mentioned in any agent file',
    cannotWrite: 'cannot write {path} ({err})',
    skipNotClaude: '{path} is not a CLAUDE.md inside the project, leaving it alone',
    skipDangling: '{path} already exists as a broken symlink, leaving it alone',
    skipExists: '{path} already exists, leaving it alone',
    skipNotFound: '{path} not found',
    skipUnreadable: 'cannot read {path}, leaving it alone',
    skipNotEmpty: '{path} is not empty, leaving it alone',
    skipManual: '{code}: can only be fixed by hand',
    more: '{list} and {rest} more',
    and: ' and ',
    newDir: 'new directory {dir}/',
    reminder:
      'forge: commands or structure changed in this task: {changes}. Check whether {docs} are out of date: commands, directory map, rules. If there is nothing to update, say so and finish.',
  },
  ru: {
    incompleteScan: 'обход каталогов оборвался на {limit} записях — часть агентских файлов могла не попасть в проверку',
    missingRootContent: 'нет корневого AGENTS.md, а CLAUDE.md в корне с содержимым — перенеси его в AGENTS.md (/forge:docs)',
    missingRoot: 'нет корневого AGENTS.md — /forge:docs поможет завести',
    missingShim: 'рядом с {agents} нет {claude} — forge docs --fix создаст ссылку @AGENTS.md',
    noImportUnreadable: 'не удалось прочитать {claude} — проверь права доступа; Claude Code его тоже не прочтёт',
    noImportEmpty: '{claude} пуст и не подключает AGENTS.md — forge docs --fix заменит его ссылкой @AGENTS.md',
    noImport: '{claude} не подключает AGENTS.md: добавь строку @AGENTS.md',
    claudeOnly: '{claude} с содержимым, а AGENTS.md рядом нет — перенеси текст в {agents} (/forge:docs)',
    fatClaude: 'в {claude} {count} непустых строк кроме импорта (больше {max}) — общее держи в AGENTS.md',
    tooLong: '{agent}: {n} строк при пределе {max} — раздели по областям (/forge:docs)',
    brokenLink: '{agent}: ссылка ведёт в несуществующий путь {missing}',
    unlisted: '{holder} не упоминает {dir}/ — добавь строку в таблицу областей',
    verifyUndocumented: 'команда проверки "{key}" (шаг {step}) не упомянута ни в одном агентском файле',
    cannotWrite: 'не удалось записать {path} ({err})',
    skipNotClaude: '{path} — не CLAUDE.md внутри проекта, не трогаю',
    skipDangling: '{path} уже существует как битая символическая ссылка — не трогаю',
    skipExists: '{path} уже существует — не трогаю',
    skipNotFound: '{path} не найден',
    skipUnreadable: 'не удалось прочитать {path} — не трогаю',
    skipNotEmpty: '{path} не пуст — не трогаю',
    skipManual: '{code}: исправляется только вручную',
    more: '{list} и ещё {rest}',
    and: ' и ',
    newDir: 'новый каталог {dir}/',
    reminder:
      'forge: в этой задаче изменились команды или структура: {changes}. Проверь, не устарели ли {docs} — команды, карта каталогов, правила. Если обновлять нечего — так и скажи и заверши работу.',
  },
});

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

/** File text without a leading BOM, or null when the file cannot be read. */
function tryRead(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function readText(file) {
  return tryRead(file) ?? '';
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

/** A symlink that resolves to the AGENTS.md next to it (CLAUDE.md -> AGENTS.md) — as good as the one-line link. */
export function isAgentsSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink() && realpathSync(file) === realpathSync(join(dirname(file), AGENTS));
  } catch {
    return false;
  }
}

/** Text of an agent file for the checks: a CLAUDE.md symlinked to its sibling AGENTS.md reads as the link. */
function agentText(file) {
  return basename(file) === CLAUDE && isAgentsSymlink(file) ? SHIM : tryRead(file);
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
      // Symlinked directories are never followed (isDirectory() is false for them); symlinked files count.
      if (item.isDirectory()) {
        if (depth < SCAN_MAX_DEPTH && !SKIP_DIRS.has(item.name) && !item.name.startsWith('.')) visit(path, depth + 1);
      } else if ((item.name === AGENTS || item.name === CLAUDE) && (item.isFile() || (item.isSymbolicLink() && isFile(join(root, path))))) {
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
 * All AGENTS.md / CLAUDE.md files of the project, relative to root, sorted (symlinks to files included).
 * In a git repository uses `git ls-files` (tracked and untracked, minus ignored) — to discover directories;
 * checkDocs then decides on disk whether a sibling exists, so an ignored CLAUDE.md next to AGENTS.md counts.
 * otherwise walks directories with a skip list, depth 6 and at most `limit` entries.
 * `complete` is false when the walk was cut short.
 */
export function findAgentFiles(root, limit = SCAN_ENTRY_LIMIT) {
  let result = null;
  if (isGitRepo(root)) {
    const listed = gitList(root);
    if (listed) {
      // `.forge/` is forge's own (work artifacts, docs backups) even when git doesn't ignore it — as in the walk.
      const files = listed.filter((p) => {
        const parts = p.split('/');
        const name = parts[parts.length - 1];
        return (name === AGENTS || name === CLAUDE) && !parts.includes('.forge') && isFile(join(root, p));
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

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * How a verify command is documented: "npm test -- {files}" → "npm test", "pytest -q" → "pytest",
 * "CI=1 cd web && npm run lint" → "npm run lint" (env assignments and "cd <dir> &&" prefixes are skipped).
 */
function commandKey(run) {
  const cut = run.includes('{') ? run.slice(0, run.indexOf('{')) : run;
  let words = cut.trim().split(/\s+/).filter(Boolean);
  for (;;) {
    if (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    else if (words[0] === 'cd' && words[2] === '&&') words = words.slice(3);
    else break;
  }
  if (!words.length) return null;
  if (SCRIPT_RUNNERS.has(words[0]) && words[1] === 'run' && words[2] && !words[2].startsWith('-')) {
    return words.slice(0, 3).join(' ');
  }
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
  // A target may hold balanced parentheses one level deep: [a](foo(bar).md).
  const re = /\[[^\]\n]*\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
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
  const maxLines = Number.isInteger(docs.max_lines) && docs.max_lines > 0 ? docs.max_lines : DEFAULT_DOCS_MAX_LINES;

  // The listing only discovers directories; whether a sibling exists is decided on disk, so a git-ignored
  // CLAUDE.md or AGENTS.md next to a listed one counts (otherwise: a missing-shim that --fix can't fix).
  const { files, complete } = findAgentFiles(root, limit);
  const dirs = [...new Set(['', ...files.map(dirOf)])].sort();
  const memo = new Map();
  const cached = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };
  const exists = (path) => cached(`?${path}`, () => isFile(join(root, path)));
  /** Text of an existing agent file; null when unreadable. */
  const rawText = (path) => cached(`=${path}`, () => agentText(join(root, path)));
  const texts = { get: (path) => rawText(path) ?? '' };
  const hasAgents = (d) => exists(join2(d, AGENTS));
  const hasClaude = (d) => exists(join2(d, CLAUDE));
  /** The agent file of a directory: AGENTS.md, else CLAUDE.md. */
  const agentFile = (d) => (hasAgents(d) ? join2(d, AGENTS) : hasClaude(d) ? join2(d, CLAUDE) : null);

  if (!complete) {
    add('incomplete-scan', 'warn', '.',
      t(MSG, 'incompleteScan', { limit }));
  }

  if (!hasAgents('')) {
    const rootClaude = hasClaude('') ? texts.get(CLAUDE) : '';
    const hasContent = nonEmptyLines(rootClaude).some((l) => l.trim() !== IMPORT_LINE);
    add('missing-root', 'error', AGENTS, hasContent
      ? t(MSG, 'missingRootContent')
      : t(MSG, 'missingRoot'));
  }

  for (const dir of dirs) {
    const agentsPath = join2(dir, AGENTS);
    const claudePath = join2(dir, CLAUDE);
    const claudeText = hasClaude(dir) ? texts.get(claudePath) : '';

    if (hasAgents(dir) && !hasClaude(dir)) {
      add('missing-shim', 'error', claudePath, t(MSG, 'missingShim', { agents: agentsPath, claude: claudePath }), true);
    }
    if (hasAgents(dir) && hasClaude(dir) && !hasImport(claudeText)) {
      // "Empty" only from a successful read: an unreadable file is never offered to --fix.
      const unreadable = rawText(claudePath) === null;
      const empty = !unreadable && claudeText.trim() === '';
      add('no-import', 'error', claudePath, unreadable
        ? t(MSG, 'noImportUnreadable', { claude: claudePath })
        : empty
          ? t(MSG, 'noImportEmpty', { claude: claudePath })
          : t(MSG, 'noImport', { claude: claudePath }), empty);
    }
    if (dir !== '' && hasClaude(dir) && !hasAgents(dir) && claudeText.trim() !== '') {
      add('claude-only', 'warn', claudePath, t(MSG, 'claudeOnly', { claude: claudePath, agents: agentsPath }));
    }
    if (hasClaude(dir)) {
      const count = nonEmptyLines(claudeText).filter((l) => l.trim() !== IMPORT_LINE).length;
      if (count > FAT_CLAUDE_LINES) {
        add('fat-claude', 'warn', claudePath, t(MSG, 'fatClaude', { claude: claudePath, count, max: FAT_CLAUDE_LINES }));
      }
    }

    const agent = agentFile(dir);
    if (agent) {
      const n = lineCount(texts.get(agent));
      if (n > maxLines) add('too-long', 'warn', agent, t(MSG, 'tooLong', { agent, n, max: maxLines }));

      const seen = new Set();
      for (const target of markdownLinks(texts.get(agent))) {
        const missing = brokenTarget(root, dir, target);
        if (missing && !seen.has(missing)) {
          seen.add(missing);
          add('broken-link', 'warn', agent, t(MSG, 'brokenLink', { agent, missing }));
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
          add('unlisted', 'warn', agentsPath, t(MSG, 'unlisted', { holder, dir }));
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
      add('verify-undocumented', 'warn', agentFile('') ?? agentFile(dirs.find(agentFile)),
        t(MSG, 'verifyUndocumented', { key, step }));
    }
  }

  return issues;
}

/**
 * Create the one-line CLAUDE.md links that checkDocs marked fixable. Never writes anything else:
 * a missing file gets "@AGENTS.md\n", an empty one (read successfully, whitespace only) is replaced by it.
 * Returns { written: paths, skipped: [{ path, reason }] } — every fixable issue left alone says why.
 */
export function fixDocs(root, issues) {
  const written = [];
  const skipped = [];
  const skip = (path, reason) => skipped.push({ path, reason });
  const cannotWrite = (path, err) => t(MSG, 'cannotWrite', { path, err: err?.code ?? err?.message ?? err });
  for (const issue of issues) {
    if (!issue.fixable) continue;
    const path = issue.path;
    const abs = resolve(root, path);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || posix.basename(path) !== CLAUDE) {
      skip(path, t(MSG, 'skipNotClaude', { path }));
    } else if (issue.code === 'missing-shim') {
      try {
        writeFileSync(abs, SHIM, { flag: 'wx' });
        written.push(path);
      } catch (err) {
        if (err?.code !== 'EEXIST') skip(path, cannotWrite(path, err));
        else if (isSymlink(abs)) skip(path, t(MSG, 'skipDangling', { path }));
        else skip(path, t(MSG, 'skipExists', { path }));
      }
    } else if (issue.code === 'no-import') {
      const text = isFile(abs) ? tryRead(abs) : '';
      if (!isFile(abs)) skip(path, t(MSG, 'skipNotFound', { path }));
      else if (text === null) skip(path, t(MSG, 'skipUnreadable', { path }));
      else if (text.trim() !== '') skip(path, t(MSG, 'skipNotEmpty', { path }));
      else {
        try {
          writeFileSync(abs, SHIM);
          written.push(path);
        } catch (err) {
          skip(path, cannotWrite(path, err));
        }
      }
    } else {
      skip(path, t(MSG, 'skipManual', { code: issue.code }));
    }
  }
  return { written, skipped };
}

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Cheap check of the two root files (no directory walk), for session start:
 * 'missing' — no root AGENTS.md; 'no-import' — CLAUDE.md does not import it; otherwise 'ok'.
 */
export function rootDocStatus(root) {
  if (!isFile(join(root, AGENTS))) return 'missing';
  const claude = join(root, CLAUDE);
  if (isFile(claude) && !hasImport(agentText(claude) ?? '')) return 'no-import';
  return 'ok';
}

function gitOut(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function parseJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fingerprint of a package.json's "scripts" (key order ignored); of the raw text when it is not JSON. */
function scriptsHash(text) {
  const data = parseJson(text);
  let basis;
  if (!isObject(data)) basis = `raw:${text}`;
  else if (isObject(data.scripts)) basis = JSON.stringify(Object.keys(data.scripts).sort().map((k) => [k, data.scripts[k]]));
  else basis = JSON.stringify(data.scripts ?? null);
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/**
 * How a package.json changed, judged by the git repository of its own directory (`git -C <dir>`), so a
 * project without git at the root, or a nested repo/submodule under a git parent, compares with the right HEAD.
 * how: null — "scripts" equals HEAD; 'scripts' — differs (or a side is unparsable); 'new' — not in HEAD
 * (also: a repo with no commits); 'any' — not in a git work tree. `hash` fingerprints the current "scripts".
 */
function packageChange(root, file) {
  const text = readText(join(root, file));
  const hash = scriptsHash(text);
  const cwd = join(root, dirOf(file));
  const base = gitOut(cwd, ['show', 'HEAD:./package.json']);
  if (base.status !== 0) {
    const inside = gitOut(cwd, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
    return { how: inside ? 'new' : 'any', hash };
  }
  const before = parseJson(base.stdout);
  const after = parseJson(text);
  if (!isObject(before) || !isObject(after)) return { how: 'scripts', hash };
  return { how: isDeepStrictEqual(before.scripts ?? null, after.scripts ?? null) ? null : 'scripts', hash };
}

/** Top-level names in HEAD (relative to root), or null when HEAD is unreadable (no commits yet). */
function headTopLevel(root) {
  const r = gitOut(root, ['ls-tree', '--name-only', '-z', 'HEAD']);
  return r.status === 0 ? new Set(r.stdout.split('\0').filter(Boolean)) : null;
}

/** The subset of `files` that git ignores. */
function gitIgnored(root, files) {
  if (!files.length) return new Set();
  const r = gitOut(root, ['check-ignore', '--stdin', '-z'], files.join('\0') + '\0');
  return new Set(r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []);
}

/** The agent file nearest to `file`, walking up to the root: AGENTS.md, else CLAUDE.md; none → root AGENTS.md. */
function nearestAgentFile(root, file) {
  let dir = dirOf(file);
  for (;;) {
    for (const name of [AGENTS, CLAUDE]) if (isFile(join(root, dir, name))) return join2(dir, name);
    if (dir === '') return AGENTS;
    dir = dirOf(dir);
  }
}

const REMIND_ITEM_MAX = 120;

/** "a, b<last>c" or, when over the budget, "a, b and N more". Always shows at least one item. */
export function fitList(items, budget, last = ', ') {
  const cut = items.map((s) => (s.length > REMIND_ITEM_MAX ? `${s.slice(0, REMIND_ITEM_MAX - 1)}…` : s));
  let shown = 1;
  let length = cut[0].length;
  while (shown < cut.length && length + 2 + cut[shown].length <= budget) length += 2 + cut[shown++].length;
  const rest = cut.length - shown;
  if (rest) return t(MSG, 'more', { list: cut.slice(0, shown).join(', '), rest });
  return cut.length === 1 ? cut[0] : `${cut.slice(0, -1).join(', ')}${last}${cut.at(-1)}`;
}

/** Reminder memory from state.docs.reminded, cleaned: { scripts: { <package.json path>: hash }, dirs: [names] }. */
function readMemory(memory) {
  const scripts = isObject(memory?.scripts)
    ? Object.fromEntries(Object.entries(memory.scripts).filter(([, v]) => typeof v === 'string'))
    : {};
  const dirs = Array.isArray(memory?.dirs) ? [...new Set(memory.dirs.filter((d) => typeof d === 'string'))] : [];
  return { scripts, dirs };
}

/** Cheap gate: an AGENTS.md at the root or in a directory above one of `files` (isFile checks only). */
function agentsAbove(root, files) {
  if (isFile(join(root, AGENTS))) return true;
  const seen = new Set();
  for (const f of files) {
    for (let d = dirOf(f); d !== '' && !seen.has(d); d = dirOf(d)) {
      seen.add(d);
      if (isFile(join(root, d, AGENTS))) return true;
    }
  }
  return false;
}

/**
 * End-of-turn reminder over the files edited in this window (relative to root).
 * Returns { reason, reminded }: reason — the Stop text, or null; reminded — the updated memory to keep in
 * state.docs.reminded (`memory` is its previous value).
 * Watched change: matches docs.watch (package.json only when "scripts" differs from HEAD of its own repo;
 * outside git — any edit), or a file inside a top-level directory that is new since HEAD and not mentioned in
 * the root AGENTS.md (root in git only). An edit of AGENTS.md or a non-link CLAUDE.md in any ancestor directory
 * closes a change. Memory: a package.json "scripts" fingerprint and a new directory are reminded once — a
 * signal unchanged since it was reminded (or closed) stays quiet; an entry is forgotten when it matches HEAD
 * again (scripts equal HEAD; the directory is in HEAD or mentioned).
 */
export function docsReminder(root, profile, files, memory) {
  const reminded = readMemory(memory);
  const quiet = { reason: null, reminded };
  // Before any git call or scan: no AGENTS.md at the root or above the edits → nothing to remind about.
  if (!files?.length || !agentsAbove(root, files)) return quiet;
  const watch = profile?.docs?.watch ?? DEFAULT_DOCS_WATCH;
  const base = (f) => f.slice(f.lastIndexOf('/') + 1);
  const top = (f) => f.slice(0, f.indexOf('/'));

  const closers = files
    .filter((f) => base(f) === AGENTS || (base(f) === CLAUDE && !isShim(readText(join(root, f)))))
    .map(dirOf);
  const closed = (f) => {
    const dir = dirOf(f);
    return closers.some((c) => c === '' || dir === c || dir.startsWith(`${c}/`));
  };

  const changes = []; // { label, file }
  for (const f of files) {
    if (!matchList(f, watch)) continue;
    if (base(f) === 'package.json') {
      const { how, hash } = packageChange(root, f);
      if (!how) {
        delete reminded.scripts[f];
        continue;
      }
      if (reminded.scripts[f] === hash) continue;
      reminded.scripts[f] = hash; // closed or reminded now: either way, not again until scripts change
      if (!closed(f)) changes.push({ label: how === 'scripts' ? `${f} (scripts)` : f, file: f });
    } else if (!closed(f)) {
      changes.push({ label: f, file: f });
    }
  }

  const candidates = files.filter((f) => f.includes('/') && !f.startsWith('.') && !matchList(f, watch));
  const head = candidates.length && isGitRepo(root) ? headTopLevel(root) : null;
  if (head) {
    const rootText = readText(join(root, AGENTS));
    const known = (dir) => head.has(dir) || mentionsDir(rootText, dir);
    reminded.dirs = reminded.dirs.filter((d) => !known(d));
    const fresh = candidates.filter((f) => !known(top(f)) && !reminded.dirs.includes(top(f)));
    const ignored = gitIgnored(root, fresh);
    const byDir = new Map(); // top-level name → first open file in it (null: all closed)
    for (const f of fresh) {
      if (ignored.has(f)) continue;
      const name = top(f);
      if (!byDir.has(name)) byDir.set(name, null);
      if (!byDir.get(name) && !closed(f)) byDir.set(name, f);
    }
    for (const [name, file] of byDir) {
      reminded.dirs.push(name);
      if (file) changes.push({ label: t(MSG, 'newDir', { dir: name }), file });
    }
  }
  if (!changes.length) return quiet;

  const docs = [...new Set(changes.map((c) => nearestAgentFile(root, c.file)))];
  const reason = t(MSG, 'reminder', {
    changes: fitList(changes.map((c) => c.label), 200),
    docs: fitList(docs, 100, t(MSG, 'and')),
  });
  return { reason, reminded };
}
