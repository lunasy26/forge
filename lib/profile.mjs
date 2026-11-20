import { existsSync } from 'node:fs';
import { forgePath } from './paths.mjs';
import { readJson } from './util.mjs';

export const MODES = ['eco', 'normal', 'max'];
export const ON_STOP = ['off', 'fast', 'full'];
export const TDD = ['off', 'encouraged', 'required'];

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

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'];

export function defaultProfile() {
  return {
    version: 1,
    commands: {},
    verify: { steps: [], on_stop: 'fast', timeout_sec: 300 },
    git: { protected_branches: [...DEFAULT_PROTECTED_BRANCHES] },
    protected_files: [...DEFAULT_PROTECTED_FILES],
    risky_paths: [],
    docs: { remind: true, max_lines: 200, watch: [...DEFAULT_DOCS_WATCH] },
    tdd: 'encouraged',
    mode: 'normal',
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

export function validateProfile(raw) {
  const errors = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!isObj(raw)) return ['профиль должен быть JSON-объектом'];
  if (raw.commands !== undefined) {
    if (!isObj(raw.commands)) errors.push('commands: ожидается объект');
    else {
      for (const [k, v] of Object.entries(raw.commands)) {
        if (!commandSpec(v)) errors.push(`commands.${k}: строка или { "run": "...", "ext": [...] }`);
      }
    }
  }
  if (raw.verify !== undefined) {
    const v = raw.verify;
    if (!isObj(v)) errors.push('verify: ожидается объект');
    else {
      if (v.steps !== undefined && !isStrArray(v.steps)) errors.push('verify.steps: массив строк');
      if (isStrArray(v.steps)) {
        for (const s of v.steps) {
          if (!raw.commands || !(s in raw.commands)) errors.push(`verify.steps: шаг "${s}" не описан в commands`);
        }
      }
      if (v.on_stop !== undefined && !ON_STOP.includes(v.on_stop)) errors.push(`verify.on_stop: одно из ${ON_STOP.join(', ')}`);
      if (v.timeout_sec !== undefined && !(Number.isInteger(v.timeout_sec) && v.timeout_sec > 0 && v.timeout_sec <= 540)) {
        errors.push('verify.timeout_sec: целое от 1 до 540');
      }
    }
  }
  if (raw.git !== undefined) {
    if (!isObj(raw.git)) errors.push('git: ожидается объект');
    else if (raw.git.protected_branches !== undefined && !isStrArray(raw.git.protected_branches)) {
      errors.push('git.protected_branches: массив строк');
    }
  }
  for (const key of ['protected_files', 'risky_paths']) {
    if (raw[key] !== undefined && !isStrArray(raw[key])) errors.push(`${key}: массив строк`);
  }
  if (raw.docs !== undefined) {
    const d = raw.docs;
    if (!isObj(d)) errors.push('docs: ожидается объект');
    else {
      if (d.remind !== undefined && typeof d.remind !== 'boolean') errors.push('docs.remind: true или false');
      if (d.max_lines !== undefined && !(Number.isInteger(d.max_lines) && d.max_lines > 0)) {
        errors.push('docs.max_lines: целое число больше 0');
      }
      if (d.watch !== undefined && !isStrArray(d.watch)) errors.push('docs.watch: массив строк');
    }
  }
  if (raw.tdd !== undefined && !TDD.includes(raw.tdd)) errors.push(`tdd: одно из ${TDD.join(', ')}`);
  if (raw.mode !== undefined && !MODES.includes(raw.mode)) errors.push(`mode: одно из ${MODES.join(', ')}`);
  if (raw.routing !== undefined && !isObj(raw.routing)) errors.push('routing: ожидается объект');
  return errors;
}

/**
 * Load the project profile merged over defaults.
 * Never throws: a broken profile yields defaults plus errors, so hooks keep working.
 */
export function loadProfile(root) {
  const file = profilePath(root);
  const profile = defaultProfile();
  if (!existsSync(file)) return { exists: false, profile, errors: [], file };
  let raw;
  try {
    raw = readJson(file);
  } catch (err) {
    return { exists: true, profile, errors: [`profile.json: невалидный JSON (${err.message})`], file };
  }
  const errors = validateProfile(raw);
  if (errors.length && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    return { exists: true, profile, errors, file };
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
  if (TDD.includes(raw.tdd)) profile.tdd = raw.tdd;
  if (MODES.includes(raw.mode)) profile.mode = raw.mode;
  if (raw.routing && typeof raw.routing === 'object' && !Array.isArray(raw.routing)) profile.routing = raw.routing;
  return { exists: true, profile, errors, file };
}
