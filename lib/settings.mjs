import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './util.mjs';

function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Settings files that can enable plugins, from lowest to highest precedence. */
export function settingsFiles(root, env = process.env) {
  return [
    join(claudeConfigDir(env), 'settings.json'),
    root && join(root, '.claude', 'settings.json'),
    root && join(root, '.claude', 'settings.local.json'),
  ].filter(Boolean);
}

/** Effective enabledPlugins map (later files override earlier ones). */
export function enabledPlugins(root) {
  const result = {};
  for (const file of settingsFiles(root)) {
    if (!existsSync(file)) continue;
    try {
      const s = readJson(file);
      if (s && typeof s.enabledPlugins === 'object') Object.assign(result, s.enabledPlugins);
    } catch {
      // ignore unreadable settings
    }
  }
  return result;
}

/** Effective `env` map of the settings files (later files override earlier ones; string values only). */
export function settingsEnv(root, env = process.env) {
  const result = {};
  for (const file of settingsFiles(root, env)) {
    if (!existsSync(file)) continue;
    try {
      const s = readJson(file);
      const e = s && typeof s.env === 'object' && s.env !== null && !Array.isArray(s.env) ? s.env : {};
      for (const [key, value] of Object.entries(e)) if (typeof value === 'string') result[key] = value;
    } catch {
      // ignore unreadable settings
    }
  }
  return result;
}

export function superpowersEnabled(root) {
  return Object.entries(enabledPlugins(root)).some(([id, on]) => on === true && /^superpowers@/.test(id));
}
