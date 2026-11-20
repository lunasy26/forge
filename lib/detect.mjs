import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBranch } from './git.mjs';
import { DEFAULT_PROTECTED_BRANCHES } from './profile.mjs';

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
  return { stack: primary.stack, profile, notes };
}
