import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBranch, latestVersionTag, listTags } from './git.mjs';
import { DEFAULT_PROTECTED_BRANCHES, DEFAULT_RELEASE_CHANGELOG } from './profile.mjs';
import { parseSemver, readVersion } from './release.mjs';

const has = (root, ...names) => names.some((n) => existsSync(join(root, n)));
const hasGlob = (root, re) => {
  try {
    return readdirSync(root).some((f) => re.test(f));
  } catch {
    return false;
  }
};
const readText = (root, name) => {
  try {
    return readFileSync(join(root, name), 'utf8');
  } catch {
    return '';
  }
};

const NPM_NO_TEST = /no test specified/;

function detectNode(root) {
  if (!has(root, 'package.json')) return null;
  let pkg = {};
  try {
    pkg = JSON.parse(readText(root, 'package.json'));
  } catch {
    // keep going with an empty package.json
  }
  const scripts = pkg.scripts || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lockb', 'bun.lock') ? 'bun' : 'npm';
  const run = (s) => (pm === 'npm' ? `npm run ${s}` : pm === 'bun' ? `bun run ${s}` : `${pm} ${s}`);
  const exec = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm];
  const js = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'];
  const commands = {};
  const notes = [];

  if (deps.prettier || has(root, '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.yaml', '.prettierrc.yml', 'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs') || pkg.prettier) {
    commands.format = `${exec} prettier --write --ignore-unknown {files}`;
  } else if (deps['@biomejs/biome'] || has(root, 'biome.json', 'biome.jsonc')) {
    commands.format = { run: `${exec} biome format --write {files}`, ext: js };
  }

  if (deps.eslint || hasGlob(root, /^(eslint\.config\.|\.eslintrc)/)) {
    commands.lint = { run: `${exec} eslint {files}`, ext: js };
  } else if (scripts.lint) {
    commands.lint = run('lint');
  }

  if (scripts.typecheck) commands.typecheck = run('typecheck');
  else if (scripts['type-check']) commands.typecheck = run('type-check');
  else if (has(root, 'tsconfig.json')) commands.typecheck = `${exec} tsc --noEmit`;

  if (scripts.test && !NPM_NO_TEST.test(scripts.test)) {
    commands.test = pm === 'npm' ? 'npm test' : run('test');
    if (deps.vitest) commands.test_fast = { run: `${exec} vitest related --run {files}`, ext: js };
    else if (deps.jest) commands.test_fast = { run: `${exec} jest --findRelatedTests {files}`, ext: js };
  } else {
    notes.push('В package.json нет скрипта test — задай commands.test вручную, если тесты есть.');
  }
  if (has(root, 'angular.json')) notes.push('Angular: проверка запускается с CI=1, чтобы ng test не ушёл в watch-режим.');
  return { stack: `node (${pm})`, commands, notes };
}

function detectPython(root) {
  if (!has(root, 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt')) return null;
  const pyproject = readText(root, 'pyproject.toml');
  const prefix = has(root, 'uv.lock') ? 'uv run ' : has(root, 'poetry.lock') ? 'poetry run ' : '';
  const commands = {};
  const notes = [];
  const py = ['.py', '.pyi'];
  if (/\[tool\.ruff/.test(pyproject) || has(root, 'ruff.toml', '.ruff.toml')) {
    commands.format = { run: `${prefix}ruff format {files}`, ext: py };
    commands.lint = { run: `${prefix}ruff check {files}`, ext: py };
  }
  if (/\[tool\.mypy/.test(pyproject) || has(root, 'mypy.ini', '.mypy.ini')) commands.typecheck = `${prefix}mypy .`;
  else if (/\[tool\.pyright/.test(pyproject) || has(root, 'pyrightconfig.json')) commands.typecheck = `${prefix}pyright`;
  if (/\[tool\.pytest/.test(pyproject) || has(root, 'pytest.ini', 'conftest.py', 'tests')) commands.test = `${prefix}pytest -q`;
  else notes.push('pytest не найден — задай commands.test вручную, если тесты есть.');
  return { stack: `python${prefix ? ` (${prefix.trim().split(' ')[0]})` : ''}`, commands, notes };
}

function detectSwift(root) {
  const pkg = has(root, 'Package.swift');
  const xcode = hasGlob(root, /\.(xcodeproj|xcworkspace)$/);
  if (!pkg && !xcode) return null;
  const commands = {};
  const notes = [];
  const sw = ['.swift'];
  if (has(root, '.swiftformat')) commands.format = { run: 'swiftformat {files}', ext: sw };
  if (has(root, '.swiftlint.yml', '.swiftlint.yaml')) commands.lint = { run: 'swiftlint lint --quiet {files}', ext: sw };
  if (pkg) commands.test = 'swift test';
  else notes.push('Xcode-проект: задай commands.test вручную (xcodebuild test -scheme … -destination …).');
  notes.push('Swift: проверка при завершении выключена (on_stop: off) — тесты долгие. Запускай forge verify вручную.');
  return { stack: pkg ? 'swift (SwiftPM)' : 'swift (Xcode)', commands, notes, on_stop: 'off' };
}

function detectGo(root) {
  if (!has(root, 'go.mod')) return null;
  return {
    stack: 'go',
    commands: { format: { run: 'gofmt -w {files}', ext: ['.go'] }, lint: 'go vet ./...', test: 'go test ./...' },
    notes: [],
  };
}

function detectRust(root) {
  if (!has(root, 'Cargo.toml')) return null;
  return {
    stack: 'rust',
    commands: { format: { run: 'rustfmt --edition 2021 {files}', ext: ['.rs'] }, lint: 'cargo clippy --quiet', test: 'cargo test --quiet' },
    notes: [],
  };
}

// ---- release ----------------------------------------------------------------------------------

const CI_PUBLISH = [
  [/\bdocker\s+(?:image\s+)?push\b/, 'CI публикует образы (docker push)'],
  [/docker\/build-push-action/, 'CI публикует образы (docker/build-push-action)'],
  [/\bnpm\s+publish\b/, 'CI публикует пакеты (npm publish)'],
  [/\btwine\s+upload\b/, 'CI публикует пакеты (twine upload)'],
  [/\bcargo\s+publish\b/, 'CI публикует пакеты (cargo publish)'],
  [/\bdotnet\s+nuget\s+push\b/, 'CI публикует пакеты (dotnet nuget push)'],
  [/\bgh\s+release\b/, 'CI создаёт релизы (gh release)'],
  [/\bgoreleaser\b/i, 'CI создаёт релизы (goreleaser)'],
];
const DISPATCH_INPUT = /^[\w-]*(?:publish|deploy|release)[\w-]*$/i;

const indentOf = (line) => /^\s*/.exec(line)[0].length;

/** Lines nested under the first `key:` line matching `keyRe` (by indentation); inline `key: {…}` yields the rest of the line. */
function blockUnder(lines, keyRe) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    const base = indentOf(lines[i]);
    if (m[1] && m[1].trim()) out.push(m[1]);
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && indentOf(lines[j]) <= base) break;
      out.push(lines[j]);
    }
  }
  return out;
}

function ciReasons(root) {
  const files = [];
  try {
    for (const f of readdirSync(join(root, '.github', 'workflows')).sort()) {
      if (/\.ya?ml$/i.test(f)) files.push(join('.github', 'workflows', f));
    }
  } catch {
    // no workflows
  }
  if (has(root, '.gitlab-ci.yml')) files.push('.gitlab-ci.yml');
  const reasons = [];
  const add = (r) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  for (const file of files) {
    const lines = readText(root, file).split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    const text = lines.join('\n');
    for (const [re, reason] of CI_PUBLISH) if (re.test(text)) add(reason);
    const push = blockUnder(lines, /^\s*push:(.*)$/).join('\n');
    if (/(^|\s|\{|,)tags\s*:/.test(push)) add('CI запускается по тегам (push: tags)');
    if (file.endsWith('.gitlab-ci.yml') && /CI_COMMIT_TAG/.test(text)) add('CI запускается по тегам (CI_COMMIT_TAG)');
    const inputs = blockUnder(blockUnder(lines, /^\s*workflow_dispatch:(.*)$/), /^\s*inputs:(.*)$/);
    const keyIndent = Math.min(...inputs.filter((x) => x.trim()).map(indentOf));
    for (const l of inputs) {
      const m = /^\s*([\w-]+)\s*:/.exec(l);
      if (m && DISPATCH_INPUT.test(m[1]) && indentOf(l) === keyIndent) {
        add(`CI запускается вручную с параметром ${m[1]} (workflow_dispatch)`);
      }
    }
  }
  return reasons;
}

const VERSION_FILE_CANDIDATES = ['package.json', '.claude-plugin/plugin.json', 'pyproject.toml', 'Cargo.toml', 'pom.xml'];
const BADGE = 'version-(\\d+\\.\\d+\\.\\d+)-';

/** Does the project look like one that cuts releases? Proposes a profile `release` block and says why. */
export function detectRelease(root) {
  const reasons = [];
  if (has(root, DEFAULT_RELEASE_CHANGELOG)) reasons.push(`найден ${DEFAULT_RELEASE_CHANGELOG}`);

  const tags = listTags(root).filter((t) => parseSemver(t.replace(/^v/, '')));
  if (tags.length) {
    const latest = latestVersionTag(root, tags.some((t) => t.startsWith('v')) ? 'v' : '');
    reasons.push(`найдены теги версий (${latest ? latest.tag : tags[0]})`);
  }
  reasons.push(...ciReasons(root));
  if (!reasons.length) return { release: null, notes: [] };

  const notes = reasons.map((r) => `Релизы включены: ${r}.`);
  const candidates = [...VERSION_FILE_CANDIDATES];
  try {
    candidates.push(...readdirSync(root).filter((f) => f.endsWith('.csproj')).sort());
  } catch {
    // unreadable root
  }
  const version_files = [];
  for (const path of candidates) {
    if (!has(root, path)) continue;
    const { version } = readVersion(root, path);
    if (version && version !== '0.0.0') {
      version_files.push(path);
      notes.push(`Версия в ${path}: ${version}.`);
    }
  }
  try {
    for (const f of readdirSync(root).filter((n) => /^README.*\.md$/i.test(n)).sort()) {
      const item = { path: f, pattern: BADGE };
      if (readVersion(root, item).version) {
        version_files.push(item);
        notes.push(`Бейдж версии в ${f}.`);
      }
    }
  } catch {
    // unreadable root
  }
  return {
    release: {
      changelog: DEFAULT_RELEASE_CHANGELOG,
      tag_prefix: tags.length && !tags.some((t) => t.startsWith('v')) ? '' : 'v',
      version_files,
    },
    notes,
  };
}

const DETECTORS = [detectNode, detectPython, detectSwift, detectGo, detectRust];

/** Propose a profile for the project. The first detected stack wins; others are reported as notes. */
export function detectProfile(root) {
  const found = DETECTORS.map((d) => d(root)).filter(Boolean);
  const primary = found[0] || { stack: 'unknown', commands: {}, notes: ['Стек не распознан — опиши commands вручную.'] };
  const notes = [...primary.notes];
  for (const other of found.slice(1)) {
    notes.push(`Найден ещё стек: ${other.stack}. Профиль описывает только ${primary.stack}; добавь команды вручную при необходимости.`);
  }
  const steps = ['typecheck', 'lint', 'test'].filter((s) => s in primary.commands);
  const branches = [...DEFAULT_PROTECTED_BRANCHES];
  const def = defaultBranch(root);
  if (def && !branches.includes(def)) branches.push(def);
  const risky = ['**/migrations/**', '.github/workflows/**'];
  const profile = {
    $schema: './profile.schema.json',
    version: 1,
    commands: primary.commands,
    verify: { steps, on_stop: primary.on_stop || 'fast', timeout_sec: 300 },
    git: { protected_branches: branches },
    protected_files: [],
    risky_paths: risky,
    tdd: 'encouraged',
    mode: 'normal',
    routing: {},
  };
  const rel = detectRelease(root);
  if (rel.release) {
    profile.release = rel.release;
    notes.push(...rel.notes);
  }
  return { stack: primary.stack, profile, notes };
}
