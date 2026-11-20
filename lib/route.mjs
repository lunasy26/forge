import { join } from 'node:path';
import { pluginRoot } from './paths.mjs';
import { readJson } from './util.mjs';
import { MODES } from './profile.mjs';

export function loadRouting(root = pluginRoot()) {
  return readJson(join(root, 'config', 'routing.json'));
}

export function parseEntry(entry) {
  if (typeof entry !== 'string') return null;
  const [model, effort] = entry.split('/');
  return model && effort ? { model, effort } : null;
}

/** Compare by model rank, then effort rank. Positive when a is stronger than b. */
export function compareStrength(routing, a, b) {
  const m = routing.models.indexOf(a.model) - routing.models.indexOf(b.model);
  if (m !== 0) return m;
  return routing.efforts.indexOf(a.effort) - routing.efforts.indexOf(b.effort);
}

/** Default table with profile overrides ({ mode: { role: "model/effort" } }) applied. */
export function mergeTable(routing, overrides = {}) {
  const table = {};
  for (const mode of MODES) {
    table[mode] = { ...routing.modes[mode], ...(overrides && typeof overrides[mode] === 'object' ? overrides[mode] : {}) };
  }
  return table;
}

export function checkTable(routing, table) {
  const errors = [];
  for (const mode of MODES) {
    const row = table[mode] || {};
    for (const role of Object.keys(routing.roles)) {
      const e = parseEntry(row[role]);
      if (!e) {
        errors.push(`${mode}.${role}: ожидается "model/effort"`);
        continue;
      }
      if (!routing.models.includes(e.model)) errors.push(`${mode}.${role}: неизвестная модель "${e.model}"`);
      if (!routing.efforts.includes(e.effort)) errors.push(`${mode}.${role}: неизвестный effort "${e.effort}"`);
    }
    for (const role of Object.keys(row)) {
      if (!(role in routing.roles)) errors.push(`${mode}.${role}: неизвестная роль`);
    }
    const reviewer = parseEntry(row.reviewer);
    const implementer = parseEntry(row.implementer);
    if (reviewer && implementer && compareStrength(routing, reviewer, implementer) < 0) {
      errors.push(`${mode}: reviewer (${row.reviewer}) слабее implementer (${row.implementer})`);
    }
    const senior = parseEntry(row.senior);
    if (senior && implementer && compareStrength(routing, senior, implementer) < 0) {
      errors.push(`${mode}: senior (${row.senior}) слабее implementer (${row.implementer}) — подними routing.${mode}.senior или понизь implementer`);
    }
    if (senior && reviewer && compareStrength(routing, reviewer, senior) < 0) {
      errors.push(`${mode}: reviewer (${row.reviewer}) слабее senior (${row.senior}) — подними routing.${mode}.reviewer или понизь senior`);
    }
    const debuggerEntry = parseEntry(row.debugger);
    if (senior && debuggerEntry && compareStrength(routing, debuggerEntry, senior) < 0) {
      errors.push(`${mode}: debugger (${row.debugger}) слабее senior (${row.senior}) — подними routing.${mode}.debugger или понизь senior`);
    }
  }
  for (const [role, entry] of Object.entries(table.eco || {})) {
    if (parseEntry(entry)?.model === 'fable') errors.push(`eco.${role}: fable в режиме eco запрещён`);
  }
  return errors;
}

/**
 * Effective table: profile overrides are applied only if the result passes every invariant;
 * otherwise the built-in table is used and the errors are returned as warnings.
 */
export function effectiveTable(routing, overrides) {
  const merged = mergeTable(routing, overrides);
  const errors = checkTable(routing, merged);
  if (!errors.length) return { table: merged, warnings: [] };
  return { table: mergeTable(routing, {}), warnings: errors };
}

export function resolveRoute(routing, table, mode, role) {
  if (!(role in routing.roles)) {
    throw new Error(`неизвестная роль "${role}". Роли: ${Object.keys(routing.roles).join(', ')}`);
  }
  const { model, effort } = parseEntry(table[mode][role]);
  const agentName = routing.roles[role].agent;
  return { role, mode, agent: agentName ? `forge:${agentName}` : 'main', model, effort };
}
