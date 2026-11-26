import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBranch, isGitRepo, latestVersionTag, listTags, remotes, remoteUrl } from './git.mjs';
import { DEFAULT_PROTECTED_BRANCHES, DEFAULT_RELEASE_CHANGELOG, WORK_PRESETS } from './profile.mjs';
import { readVersion } from './release.mjs';
import { parseSemver } from './semver.mjs';
import { defineCatalog, t } from './i18n.mjs';

const MSG = defineCatalog({
  en: {
    noTestScript: 'package.json has no test script — set commands.test manually if there are tests.',
    angular: 'Angular: verification runs with CI=1 so that ng test does not go into watch mode.',
    noPytest: 'pytest not found — set commands.test manually if there are tests.',
    xcodeNoTest: 'Xcode project: set commands.test manually (xcodebuild test -scheme … -destination …).',
    swiftOff: 'Swift: verification on stop is off (on_stop: off) — tests are slow. Run forge verify manually.',
    ciImages: 'CI publishes images ({via})',
    ciPackages: 'CI publishes packages ({via})',
    ciReleases: 'CI creates releases ({via})',
    ciTags: 'CI runs on tags ({via})',
    ciDispatch: 'CI runs manually with the {input} input (workflow_dispatch)',
    foundChangelog: '{file} found',
    foundTags: 'version tags found ({tag})',
    releasesOn: 'Releases enabled: {reason}.',
    versionIn: 'Version in {path}: {version}.',
    badge: 'Version badge in {file}.',
    unknownStack: 'Stack not recognized — describe commands manually.',
    otherStack: 'Another stack found: {stack}. The profile only describes {primary}; add commands manually if needed.',
    workDocs: 'found {dir}/ — specs and plans will be written to the repository (forge init --work local to keep them out of git).',
  },
  ru: {
    noTestScript: 'В package.json нет скрипта test — задай commands.test вручную, если тесты есть.',
    angular: 'Angular: проверка запускается с CI=1, чтобы ng test не ушёл в watch-режим.',
    noPytest: 'pytest не найден — задай commands.test вручную, если тесты есть.',
    xcodeNoTest: 'Xcode-проект: задай commands.test вручную (xcodebuild test -scheme … -destination …).',
    swiftOff: 'Swift: проверка при завершении выключена (on_stop: off) — тесты долгие. Запускай forge verify вручную.',
    ciImages: 'CI публикует образы ({via})',
    ciPackages: 'CI публикует пакеты ({via})',
    ciReleases: 'CI создаёт релизы ({via})',
    ciTags: 'CI запускается по тегам ({via})',
    ciDispatch: 'CI запускается вручную с параметром {input} (workflow_dispatch)',
    foundChangelog: 'найден {file}',
    foundTags: 'найдены теги версий ({tag})',
    releasesOn: 'Релизы включены: {reason}.',
    versionIn: 'Версия в {path}: {version}.',
    badge: 'Бейдж версии в {file}.',
    unknownStack: 'Стек не распознан — опиши commands вручную.',
    otherStack: 'Найден ещё стек: {stack}. Профиль описывает только {primary}; добавь команды вручную при необходимости.',
    workDocs: 'найден {dir}/ — спеки и планы будут записываться в репозиторий (forge init --work local, чтобы держать их вне git).',
  },
});

const has = (root, ...names) => names.some((n) => existsSync(join(root, n)));
const hasGlob = (root, re) => {
  try {
    return readdirSync(root).some((f) => re.test(f));
  } catch {
    return false;
  }
};
const isDir = (root, name) => {
  try {
    return statSync(join(root, name)).isDirectory();
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
    notes.push(t(MSG, 'noTestScript'));
  }
  if (has(root, 'angular.json')) notes.push(t(MSG, 'angular'));
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
  else notes.push(t(MSG, 'noPytest'));
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
  else notes.push(t(MSG, 'xcodeNoTest'));
  notes.push(t(MSG, 'swiftOff'));
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
  [/\bdocker\s+(?:image\s+)?push\b/, 'ciImages', 'docker push'],
  [/docker\/build-push-action/, 'ciImages', 'docker/build-push-action'],
  [/\bnpm\s+publish\b/, 'ciPackages', 'npm publish'],
  [/\btwine\s+upload\b/, 'ciPackages', 'twine upload'],
  [/\bcargo\s+publish\b/, 'ciPackages', 'cargo publish'],
  [/\bdotnet\s+nuget\s+push\b/, 'ciPackages', 'dotnet nuget push'],
  [/\bgh\s+release\b/, 'ciReleases', 'gh release'],
  [/\bgoreleaser\b/i, 'ciReleases', 'goreleaser'],
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
    for (const [re, key, via] of CI_PUBLISH) if (re.test(text)) add(t(MSG, key, { via }));
    const push = blockUnder(lines, /^\s*push:(.*)$/).join('\n');
    if (/(^|\s|\{|,)tags\s*:/.test(push)) add(t(MSG, 'ciTags', { via: 'push: tags' }));
    if (file.endsWith('.gitlab-ci.yml') && /CI_COMMIT_TAG/.test(text)) add(t(MSG, 'ciTags', { via: 'CI_COMMIT_TAG' }));
    const inputs = blockUnder(blockUnder(lines, /^\s*workflow_dispatch:(.*)$/), /^\s*inputs:(.*)$/);
    const keyIndent = Math.min(...inputs.filter((x) => x.trim()).map(indentOf));
    for (const l of inputs) {
      const m = /^\s*([\w-]+)\s*:/.exec(l);
      if (m && DISPATCH_INPUT.test(m[1]) && indentOf(l) === keyIndent) {
        add(t(MSG, 'ciDispatch', { input: m[1] }));
      }
    }
  }
  return reasons;
}

const VERSION_FILE_CANDIDATES = ['package.json', '.claude-plugin/plugin.json', 'pyproject.toml', 'Cargo.toml', 'pom.xml'];
const BADGE = 'badge/version-(\\d+\\.\\d+\\.\\d+)-';

/** Does the project look like one that cuts releases? Proposes a profile `release` block and says why. */
export function detectRelease(root) {
  const reasons = [];
  if (has(root, DEFAULT_RELEASE_CHANGELOG)) reasons.push(t(MSG, 'foundChangelog', { file: DEFAULT_RELEASE_CHANGELOG }));

  const tags = listTags(root).filter((t) => parseSemver(t.replace(/^v/, '')));
  if (tags.length) {
    const latest = latestVersionTag(root, tags.some((t) => t.startsWith('v')) ? 'v' : '');
    reasons.push(t(MSG, 'foundTags', { tag: latest ? latest.tag : tags[0] }));
  }
  reasons.push(...ciReasons(root));
  if (!reasons.length) return { release: null, notes: [] };

  const notes = reasons.map((r) => t(MSG, 'releasesOn', { reason: r }));
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
    if (parseSemver(version) && version !== '0.0.0') {
      version_files.push(path);
      notes.push(t(MSG, 'versionIn', { path, version }));
    }
  }
  try {
    for (const f of readdirSync(root).filter((n) => /^README.*\.md$/i.test(n)).sort()) {
      const item = { path: f, pattern: BADGE };
      if (readVersion(root, item).version) {
        version_files.push(item);
        notes.push(t(MSG, 'badge', { file: f }));
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

/**
 * Propose `git.flow`: no remotes means a local merge, a GitHub origin means a pull request;
 * anything else (other host, remotes without origin, not a git repository) is not guessed.
 */
export function detectFlow(root) {
  if (!isGitRepo(root)) return undefined;
  const names = remotes(root);
  if (!names.length) return 'merge';
  const url = names.includes('origin') ? remoteUrl(root, 'origin') : null;
  if (url && /github\.com[:/]/.test(url)) return 'pr';
  return undefined;
}

const DETECTORS = [detectNode, detectPython, detectSwift, detectGo, detectRust];

/**
 * Propose a profile for the project. The first detected stack wins; others are reported as notes.
 * `workNote` (set only when docs/plans/ or docs/specs/ exists) is kept apart from `notes`: it explains
 * the proposed `work` paths, so the caller shows it only when the user did not choose them with `--work`.
 */
export function detectProfile(root) {
  const found = DETECTORS.map((d) => d(root)).filter(Boolean);
  const primary = found[0] || { stack: 'unknown', commands: {}, notes: [t(MSG, 'unknownStack')] };
  const notes = [...primary.notes];
  for (const other of found.slice(1)) {
    notes.push(t(MSG, 'otherStack', { stack: other.stack, primary: primary.stack }));
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
  const flow = detectFlow(root);
  if (flow) profile.git.flow = flow;
  let workNote = null;
  const docsDir = ['docs/plans', 'docs/specs'].find((d) => isDir(root, d));
  if (docsDir) {
    profile.work = { ...WORK_PRESETS.docs };
    workNote = t(MSG, 'workDocs', { dir: docsDir });
  } else {
    profile.work = { ...WORK_PRESETS.local };
  }
  const rel = detectRelease(root);
  if (rel.release) {
    profile.release = rel.release;
    notes.push(...rel.notes);
  }
  return { stack: primary.stack, profile, notes, workNote };
}
