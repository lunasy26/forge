import { join } from 'node:path';
import { pluginRoot } from './paths.mjs';
import { readJson } from './util.mjs';
import { MODES } from './profile.mjs';
import { defineCatalog, t } from './i18n.mjs';

const MSG = defineCatalog({
  en: {
    expected: '{mode}.{role}: "model/effort" is expected',
    unknownModel: '{mode}.{role}: unknown model "{model}"',
    unknownEffort: '{mode}.{role}: unknown effort "{effort}"',
    unknownRole: '{mode}.{role}: unknown role',
    reviewerWeaker: '{mode}: reviewer ({reviewer}) is weaker than implementer ({implementer})',
    seniorWeaker: '{mode}: senior ({senior}) is weaker than implementer ({implementer}) - raise routing.{mode}.senior or lower implementer',
    reviewerWeakerSenior: '{mode}: reviewer ({reviewer}) is weaker than senior ({senior}) - raise routing.{mode}.reviewer or lower senior',
    debuggerWeaker: '{mode}: debugger ({debugger}) is weaker than senior ({senior}) - raise routing.{mode}.debugger or lower senior',
    fableEco: 'eco.{role}: fable is not allowed in eco mode',
    unknownRoleError: 'unknown role "{role}". Roles: {roles}',
  },
  ru: {
    expected: '{mode}.{role}: ожидается "model/effort"',
    unknownModel: '{mode}.{role}: неизвестная модель "{model}"',
    unknownEffort: '{mode}.{role}: неизвестный effort "{effort}"',
    unknownRole: '{mode}.{role}: неизвестная роль',
    reviewerWeaker: '{mode}: reviewer ({reviewer}) слабее implementer ({implementer})',
    seniorWeaker: '{mode}: senior ({senior}) слабее implementer ({implementer}) — подними routing.{mode}.senior или понизь implementer',
    reviewerWeakerSenior: '{mode}: reviewer ({reviewer}) слабее senior ({senior}) — подними routing.{mode}.reviewer или понизь senior',
    debuggerWeaker: '{mode}: debugger ({debugger}) слабее senior ({senior}) — подними routing.{mode}.debugger или понизь senior',
    fableEco: 'eco.{role}: fable в режиме eco запрещён',
    unknownRoleError: 'неизвестная роль "{role}". Роли: {roles}',
  },
});

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
        errors.push(t(MSG, 'expected', { mode, role }));
        continue;
      }
      if (!routing.models.includes(e.model)) errors.push(t(MSG, 'unknownModel', { mode, role, model: e.model }));
      if (!routing.efforts.includes(e.effort)) errors.push(t(MSG, 'unknownEffort', { mode, role, effort: e.effort }));
    }
    for (const role of Object.keys(row)) {
      if (!(role in routing.roles)) errors.push(t(MSG, 'unknownRole', { mode, role }));
    }
    const reviewer = parseEntry(row.reviewer);
    const implementer = parseEntry(row.implementer);
    if (reviewer && implementer && compareStrength(routing, reviewer, implementer) < 0) {
      errors.push(t(MSG, 'reviewerWeaker', { mode, reviewer: row.reviewer, implementer: row.implementer }));
    }
    const senior = parseEntry(row.senior);
    if (senior && implementer && compareStrength(routing, senior, implementer) < 0) {
      errors.push(t(MSG, 'seniorWeaker', { mode, senior: row.senior, implementer: row.implementer }));
    }
    if (senior && reviewer && compareStrength(routing, reviewer, senior) < 0) {
      errors.push(t(MSG, 'reviewerWeakerSenior', { mode, reviewer: row.reviewer, senior: row.senior }));
    }
    const debuggerEntry = parseEntry(row.debugger);
    if (senior && debuggerEntry && compareStrength(routing, debuggerEntry, senior) < 0) {
      errors.push(t(MSG, 'debuggerWeaker', { mode, debugger: row.debugger, senior: row.senior }));
    }
  }
  for (const [role, entry] of Object.entries(table.eco || {})) {
    if (parseEntry(entry)?.model === 'fable') errors.push(t(MSG, 'fableEco', { role }));
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
    throw new Error(t(MSG, 'unknownRoleError', { role, roles: Object.keys(routing.roles).join(', ') }));
  }
  const { model, effort } = parseEntry(table[mode][role]);
  const agentName = routing.roles[role].agent;
  return { role, mode, agent: agentName ? `forge:${agentName}` : 'main', model, effort };
}
