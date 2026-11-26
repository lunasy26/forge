import { existsSync } from 'node:fs';
import { forgePath, mainWorktree } from './paths.mjs';
import { readJson } from './util.mjs';
import { LANGS, defineCatalog, t } from './i18n.mjs';

const MSG = defineCatalog({
  en: {
    vfEmptyPath: 'the path must not be empty',
    vfShape: 'a path string or { "path": "...", "pattern": "..." }',
    vfPath: 'path: a non-empty string',
    vfPattern: 'pattern: a non-empty string (regular expression)',
    vfBadRegex: 'pattern: invalid regular expression ({msg})',
    vfGroups: 'pattern: exactly one capture group is required, found {n}',
    notObject: 'the profile must be a JSON object',
    expectObject: '{key}: an object is expected',
    commandShape: 'commands.{key}: a string or { "run": "...", "ext": [...] }',
    stringArray: '{key}: an array of strings',
    stepUndefined: 'verify.steps: step "{step}" is not defined in commands',
    oneOf: '{key}: one of {values}',
    timeout: 'verify.timeout_sec: an integer from 1 to 540',
    remind: '{key}: true or false',
    maxLines: 'docs.max_lines: an integer greater than 0',
    changelog: 'release.changelog: a non-empty string (path)',
    tagPrefix: 'release.tag_prefix: a string',
    versionFilesArray: 'release.version_files: an array',
    versionFileItem: 'release.version_files[{index}]: {error}',
    invalidJson: 'profile.json: invalid JSON ({msg})',
  },
  ru: {
    vfEmptyPath: 'путь не должен быть пустым',
    vfShape: 'строка-путь или { "path": "...", "pattern": "..." }',
    vfPath: 'path: непустая строка',
    vfPattern: 'pattern: непустая строка (регулярное выражение)',
    vfBadRegex: 'pattern: невалидное регулярное выражение ({msg})',
    vfGroups: 'pattern: нужна ровно одна группа захвата, найдено {n}',
    notObject: 'профиль должен быть JSON-объектом',
    expectObject: '{key}: ожидается объект',
    commandShape: 'commands.{key}: строка или { "run": "...", "ext": [...] }',
    stringArray: '{key}: массив строк',
    stepUndefined: 'verify.steps: шаг "{step}" не описан в commands',
    oneOf: '{key}: одно из {values}',
    timeout: 'verify.timeout_sec: целое от 1 до 540',
    remind: '{key}: true или false',
    maxLines: 'docs.max_lines: целое число больше 0',
    changelog: 'release.changelog: непустая строка (путь)',
    tagPrefix: 'release.tag_prefix: строка',
    versionFilesArray: 'release.version_files: массив',
    versionFileItem: 'release.version_files[{index}]: {error}',
    invalidJson: 'profile.json: невалидный JSON ({msg})',
  },
});

export const MODES = ['eco', 'normal', 'max'];
export const ON_STOP = ['off', 'fast', 'full'];
export const TDD = ['off', 'encouraged', 'required'];
export const LANGUAGES = ['auto', ...LANGS];

/** Built-in protections. Profile entries are appended, so a profile can unprotect with "!pattern". */
export const DEFAULT_PROTECTED_FILES = [
  '.env',
  '.env.*',
  '.envrc',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa',
  '**/id_ed25519',
];

/** Files whose change should make the agent docs worth re-checking. Profile entries are appended; "!pattern" removes. */
export const DEFAULT_DOCS_WATCH = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  '*.sln',
  'Makefile',
  'justfile',
  'Taskfile.yml',
  'docker-compose*.yml',
  'compose*.yml',
  '.github/workflows/**',
  '.gitlab-ci.yml',
];

/** Edits that need no changelog entry. Profile release.ignore is appended; "!pattern" removes. */
export const DEFAULT_RELEASE_IGNORE = [
  'test/**',
  'tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  'docs/**',
  '*.md',
  '**/*.md',
  '.forge/**',
];

export const DEFAULT_RELEASE_CHANGELOG = 'CHANGELOG.md';
export const DEFAULT_RELEASE_TAG_PREFIX = 'v';

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'];

/** Agent files longer than this get a too-long warning (profile docs.max_lines overrides). */
export const DEFAULT_DOCS_MAX_LINES = 200;

export function defaultProfile() {
  return {
    version: 1,
    commands: {},
    verify: { steps: [], on_stop: 'fast', timeout_sec: 300 },
    git: { protected_branches: [...DEFAULT_PROTECTED_BRANCHES] },
    protected_files: [...DEFAULT_PROTECTED_FILES],
    risky_paths: [],
    docs: { remind: true, max_lines: DEFAULT_DOCS_MAX_LINES, watch: [...DEFAULT_DOCS_WATCH] },
    secrets: { check: true, ignore: [] },
    tdd: 'encouraged',
    mode: 'normal',
    language: 'auto',
    routing: {},
  };
}

export function profilePath(root) {
  return forgePath(root, 'profile.json');
}

/** A command is either "cmd {files}" or { run, ext: [".ts"] }. */
export function commandSpec(value) {
  if (typeof value === 'string') return { run: value, ext: null };
  if (value && typeof value === 'object' && typeof value.run === 'string') {
    return { run: value.run, ext: Array.isArray(value.ext) ? value.ext : null };
  }
  return null;
}

/**
 * Check one release.version_files item: a path string or { path, pattern }.
 * pattern is a regex source with exactly one capture group (the version). Returns an error text or null.
 */
export function versionFileError(item) {
  if (typeof item === 'string') return item ? null : t(MSG, 'vfEmptyPath');
  if (!item || typeof item !== 'object' || Array.isArray(item)) return t(MSG, 'vfShape');
  if (typeof item.path !== 'string' || !item.path) return t(MSG, 'vfPath');
  if (typeof item.pattern !== 'string' || !item.pattern) return t(MSG, 'vfPattern');
  let groups;
  try {
    groups = new RegExp(`${item.pattern}|`).exec('').length - 1;
  } catch (err) {
    return t(MSG, 'vfBadRegex', { msg: err.message });
  }
  if (groups !== 1) return t(MSG, 'vfGroups', { n: groups });
  return null;
}

export function validateProfile(raw) {
  const errors = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!isObj(raw)) return [t(MSG, 'notObject')];
  if (raw.commands !== undefined) {
    if (!isObj(raw.commands)) errors.push(t(MSG, 'expectObject', { key: 'commands' }));
    else {
      for (const [k, v] of Object.entries(raw.commands)) {
        if (!commandSpec(v)) errors.push(t(MSG, 'commandShape', { key: k }));
      }
    }
  }
  if (raw.verify !== undefined) {
    const v = raw.verify;
    if (!isObj(v)) errors.push(t(MSG, 'expectObject', { key: 'verify' }));
    else {
      if (v.steps !== undefined && !isStrArray(v.steps)) errors.push(t(MSG, 'stringArray', { key: 'verify.steps' }));
      if (isStrArray(v.steps)) {
        for (const s of v.steps) {
          if (!raw.commands || !(s in raw.commands)) errors.push(t(MSG, 'stepUndefined', { step: s }));
        }
      }
      if (v.on_stop !== undefined && !ON_STOP.includes(v.on_stop)) errors.push(t(MSG, 'oneOf', { key: 'verify.on_stop', values: ON_STOP.join(', ') }));
      if (v.timeout_sec !== undefined && !(Number.isInteger(v.timeout_sec) && v.timeout_sec > 0 && v.timeout_sec <= 540)) {
        errors.push(t(MSG, 'timeout'));
      }
    }
  }
  if (raw.git !== undefined) {
    if (!isObj(raw.git)) errors.push(t(MSG, 'expectObject', { key: 'git' }));
    else if (raw.git.protected_branches !== undefined && !isStrArray(raw.git.protected_branches)) {
      errors.push(t(MSG, 'stringArray', { key: 'git.protected_branches' }));
    }
  }
  for (const key of ['protected_files', 'risky_paths']) {
    if (raw[key] !== undefined && !isStrArray(raw[key])) errors.push(t(MSG, 'stringArray', { key }));
  }
  if (raw.docs !== undefined) {
    const d = raw.docs;
    if (!isObj(d)) errors.push(t(MSG, 'expectObject', { key: 'docs' }));
    else {
      if (d.remind !== undefined && typeof d.remind !== 'boolean') errors.push(t(MSG, 'remind', { key: 'docs.remind' }));
      if (d.max_lines !== undefined && !(Number.isInteger(d.max_lines) && d.max_lines > 0)) {
        errors.push(t(MSG, 'maxLines'));
      }
      if (d.watch !== undefined && !isStrArray(d.watch)) errors.push(t(MSG, 'stringArray', { key: 'docs.watch' }));
    }
  }
  if (raw.release !== undefined) {
    const r = raw.release;
    if (!isObj(r)) errors.push(t(MSG, 'expectObject', { key: 'release' }));
    else {
      if (r.changelog !== undefined && !(typeof r.changelog === 'string' && r.changelog)) {
        errors.push(t(MSG, 'changelog'));
      }
      if (r.tag_prefix !== undefined && typeof r.tag_prefix !== 'string') errors.push(t(MSG, 'tagPrefix'));
      if (r.version_files !== undefined) {
        if (!Array.isArray(r.version_files)) errors.push(t(MSG, 'versionFilesArray'));
        else {
          r.version_files.forEach((item, i) => {
            const err = versionFileError(item);
            if (err) errors.push(t(MSG, 'versionFileItem', { index: i, error: err }));
          });
        }
      }
      if (r.remind !== undefined && typeof r.remind !== 'boolean') errors.push(t(MSG, 'remind', { key: 'release.remind' }));
      if (r.ignore !== undefined && !isStrArray(r.ignore)) errors.push(t(MSG, 'stringArray', { key: 'release.ignore' }));
    }
  }
  if (raw.secrets !== undefined) {
    const s = raw.secrets;
    if (!isObj(s)) errors.push(t(MSG, 'expectObject', { key: 'secrets' }));
    else {
      if (s.check !== undefined && typeof s.check !== 'boolean') errors.push(t(MSG, 'remind', { key: 'secrets.check' }));
      if (s.ignore !== undefined && !isStrArray(s.ignore)) errors.push(t(MSG, 'stringArray', { key: 'secrets.ignore' }));
    }
  }
  if (raw.tdd !== undefined && !TDD.includes(raw.tdd)) errors.push(t(MSG, 'oneOf', { key: 'tdd', values: TDD.join(', ') }));
  if (raw.mode !== undefined && !MODES.includes(raw.mode)) errors.push(t(MSG, 'oneOf', { key: 'mode', values: MODES.join(', ') }));
  if (raw.language !== undefined && !LANGUAGES.includes(raw.language)) errors.push(t(MSG, 'oneOf', { key: 'language', values: LANGUAGES.join(', ') }));
  if (raw.routing !== undefined && !isObj(raw.routing)) errors.push(t(MSG, 'expectObject', { key: 'routing' }));
  return errors;
}

/**
 * The profile file that applies to root: its own .forge/profile.json, or, in a linked git worktree
 * without one, the main checkout's (.forge/ is ignored, so a new worktree has none). The inherited
 * profile is only read; state, the edit log and plans stay per worktree.
 * Returns { file, inherited }: inherited is the main checkout's path or null.
 */
export function resolveProfileFile(root) {
  const own = profilePath(root);
  if (existsSync(own)) return { file: own, inherited: null };
  const main = mainWorktree(root);
  if (main && existsSync(profilePath(main))) return { file: profilePath(main), inherited: main };
  return { file: own, inherited: null };
}

/**
 * Load the project profile merged over defaults.
 * Never throws: a broken profile yields defaults plus errors, so hooks keep working.
 */
export function loadProfile(root) {
  const { file, inherited } = resolveProfileFile(root);
  const profile = defaultProfile();
  if (!existsSync(file)) return { exists: false, profile, errors: [], file, inherited };
  let raw;
  try {
    raw = readJson(file);
  } catch (err) {
    return { exists: true, profile, errors: [t(MSG, 'invalidJson', { msg: err.message })], file, inherited };
  }
  const errors = validateProfile(raw);
  if (errors.length && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    return { exists: true, profile, errors, file, inherited };
  }
  const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (raw.commands && typeof raw.commands === 'object') {
    for (const [k, v] of Object.entries(raw.commands)) if (commandSpec(v)) profile.commands[k] = v;
  }
  if (raw.verify && typeof raw.verify === 'object') {
    if (isStrArray(raw.verify.steps)) profile.verify.steps = raw.verify.steps.filter((s) => s in profile.commands);
    if (ON_STOP.includes(raw.verify.on_stop)) profile.verify.on_stop = raw.verify.on_stop;
    if (Number.isInteger(raw.verify.timeout_sec) && raw.verify.timeout_sec > 0 && raw.verify.timeout_sec <= 540) {
      profile.verify.timeout_sec = raw.verify.timeout_sec;
    }
  }
  if (raw.git && isStrArray(raw.git.protected_branches)) profile.git.protected_branches = raw.git.protected_branches;
  if (isStrArray(raw.protected_files)) profile.protected_files = [...DEFAULT_PROTECTED_FILES, ...raw.protected_files];
  if (isStrArray(raw.risky_paths)) profile.risky_paths = raw.risky_paths;
  if (raw.docs && typeof raw.docs === 'object' && !Array.isArray(raw.docs)) {
    if (typeof raw.docs.remind === 'boolean') profile.docs.remind = raw.docs.remind;
    if (Number.isInteger(raw.docs.max_lines) && raw.docs.max_lines > 0) profile.docs.max_lines = raw.docs.max_lines;
    if (isStrArray(raw.docs.watch)) profile.docs.watch = [...DEFAULT_DOCS_WATCH, ...raw.docs.watch];
  }
  if (raw.release && typeof raw.release === 'object' && !Array.isArray(raw.release)) {
    const r = raw.release;
    profile.release = {
      changelog: DEFAULT_RELEASE_CHANGELOG,
      tag_prefix: DEFAULT_RELEASE_TAG_PREFIX,
      version_files: [],
      remind: true,
      ignore: [...DEFAULT_RELEASE_IGNORE],
    };
    if (typeof r.changelog === 'string' && r.changelog) profile.release.changelog = r.changelog;
    if (typeof r.tag_prefix === 'string') profile.release.tag_prefix = r.tag_prefix;
    if (Array.isArray(r.version_files)) profile.release.version_files = r.version_files.filter((item) => !versionFileError(item));
    if (typeof r.remind === 'boolean') profile.release.remind = r.remind;
    if (isStrArray(r.ignore)) profile.release.ignore = [...DEFAULT_RELEASE_IGNORE, ...r.ignore];
  }
  if (raw.secrets && typeof raw.secrets === 'object' && !Array.isArray(raw.secrets)) {
    if (typeof raw.secrets.check === 'boolean') profile.secrets.check = raw.secrets.check;
    if (isStrArray(raw.secrets.ignore)) profile.secrets.ignore = [...raw.secrets.ignore];
  }
  if (TDD.includes(raw.tdd)) profile.tdd = raw.tdd;
  if (MODES.includes(raw.mode)) profile.mode = raw.mode;
  if (LANGUAGES.includes(raw.language)) profile.language = raw.language;
  if (raw.routing && typeof raw.routing === 'object' && !Array.isArray(raw.routing)) profile.routing = raw.routing;
  return { exists: true, profile, errors, file, inherited };
}
