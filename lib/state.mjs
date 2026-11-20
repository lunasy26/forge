import { existsSync } from 'node:fs';
import { forgePath } from './paths.mjs';
import { readJson, writeJsonAtomic } from './util.mjs';
import { MODES } from './profile.mjs';
import { defineCatalog, t } from './i18n.mjs';

const MSG = defineCatalog({
  en: {
    tier: 'tier: an integer 0-3',
    stage: 'stage: one of {values} or null',
    mode: 'mode: one of {values} or null',
  },
  ru: {
    tier: 'tier: целое 0–3',
    stage: 'stage: одно из {values} или null',
    mode: 'mode: одно из {values} или null',
  },
});

export const STAGES = ['spec', 'plan', 'execute', 'review', 'finish'];

export function defaultState() {
  return {
    version: 1,
    tier: 1,
    stage: null,
    mode: null,
    task: null,
    artifacts: {},
    verify: null,
    failures: { verify_streak: 0 },
    lint_offset: 0,
  };
}

export function statePath(root) {
  return forgePath(root, 'state.json');
}

export function loadState(root) {
  const state = defaultState();
  const file = statePath(root);
  if (!existsSync(file)) return state;
  try {
    const raw = readJson(file);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) Object.assign(state, raw);
  } catch {
    // corrupted state: start over rather than block work
  }
  if (!state.failures || typeof state.failures !== 'object') state.failures = { verify_streak: 0 };
  if (!state.artifacts || typeof state.artifacts !== 'object') state.artifacts = {};
  return state;
}

export function saveState(root, state) {
  writeJsonAtomic(statePath(root), state);
}

export function updateState(root, fn) {
  const state = loadState(root);
  const next = fn(state) || state;
  saveState(root, next);
  return next;
}

/** Validate a user-supplied value for a known key; returns an error string or null. */
export function validateStateValue(key, value) {
  if (key === 'tier' && !(Number.isInteger(value) && value >= 0 && value <= 3)) return t(MSG, 'tier');
  if (key === 'stage' && value !== null && !STAGES.includes(value)) return t(MSG, 'stage', { values: STAGES.join(', ') });
  if (key === 'mode' && value !== null && !MODES.includes(value)) return t(MSG, 'mode', { values: MODES.join(', ') });
  return null;
}

export function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}

export function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
