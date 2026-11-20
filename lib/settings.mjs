import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './util.mjs';

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Settings files that can enable plugins, from lowest to highest precedence. */
export function settingsFiles(root) {
  return [
    join(claudeConfigDir(), 'settings.json'),
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

export function superpowersEnabled(root) {
  return Object.entries(enabledPlugins(root)).some(([id, on]) => on === true && /^superpowers@/.test(id));
}
