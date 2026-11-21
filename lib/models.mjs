import { defineCatalog, t } from './i18n.mjs';
import { parseEntry } from './route.mjs';
import { settingsEnv } from './settings.mjs';

const MSG = defineCatalog({
  en: {
    subagentForced: 'Models: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on — every subagent runs on one model ({model}), forge roles and modes have no effect',
    aliasUnmapped: 'Models: {setup} without a mapping for aliases {aliases} — set {vars}, otherwise roles may run on the wrong model',
    aliasSameModel: 'Models: aliases map to the same model ({groups}) — the tiers do not differ, "reviewer not weaker than implementer" loses its meaning',
    effortForced: 'Models: CLAUDE_CODE_EFFORT_LEVEL={level} is set — the effort from the forge table is not applied',
    okDirect: 'Models: Anthropic directly',
    okAliases: 'Models: aliases {list}',
    okSetup: 'Models: {setup}',
    setupGateway: 'gateway {host}',
    setupProvider: 'provider {name}',
    notSet: 'CLAUDE_CODE_SUBAGENT_MODEL is not set',
  },
  ru: {
    subagentForced: 'Модели: включён CLAUDE_CODE_SUBAGENT_MODEL_FORCE — все субагенты на одной модели ({model}), роли и режимы forge не действуют',
    aliasUnmapped: 'Модели: {setup}, но для псевдонимов {aliases} нет отображения — задай {vars}, иначе роли могут работать не на той модели',
    aliasSameModel: 'Модели: псевдонимы отображены на одну модель ({groups}) — ступени не различаются, правило «ревьюер не слабее исполнителя» теряет смысл',
    effortForced: 'Модели: задан CLAUDE_CODE_EFFORT_LEVEL={level} — effort из таблицы forge не применяется',
    okDirect: 'Модели: Anthropic напрямую',
    okAliases: 'Модели: псевдонимы {list}',
    okSetup: 'Модели: {setup}',
    setupGateway: 'шлюз {host}',
    setupProvider: 'провайдер {name}',
    notSet: 'CLAUDE_CODE_SUBAGENT_MODEL не задана',
  },
});

const ALIAS_VARS = {
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};
const PROVIDERS = { CLAUDE_CODE_USE_BEDROCK: 'Bedrock', CLAUDE_CODE_USE_VERTEX: 'Vertex', CLAUDE_CODE_USE_FOUNDRY: 'Foundry' };
const KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_EFFORT_LEVEL',
  ...Object.keys(PROVIDERS),
  ...Object.values(ALIAS_VARS),
];

const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? '').trim());
const value = (env, key) => (typeof env[key] === 'string' ? env[key].trim() : '');

/** Model-related variables: process env over the `env` of Claude Code settings files. */
export function modelEnv(root, processEnv = process.env) {
  const merged = { ...settingsEnv(root, processEnv), ...processEnv };
  const result = {};
  for (const key of KEYS) if (typeof merged[key] === 'string') result[key] = merged[key];
  return result;
}

/** Distinct models of the routing table row for a mode, in the order the routing file lists them. */
export function tableAliases(routing, table, mode) {
  const used = new Set(Object.values(table[mode] || {}).map((e) => parseEntry(e)?.model).filter(Boolean));
  return routing.models.filter((m) => used.has(m));
}

function gatewayHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/** [{ code, level: 'warn' | 'ok', message }] — whether the environment keeps forge model aliases working. */
export function checkModels({ env = {}, aliases = [] } = {}) {
  const issues = [];
  const warn = (code, message) => issues.push({ code, level: 'warn', message });

  if (truthy(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)) {
    warn('subagent-forced', t(MSG, 'subagentForced', { model: value(env, 'CLAUDE_CODE_SUBAGENT_MODEL') || t(MSG, 'notSet') }));
  }

  const setups = [];
  const url = value(env, 'ANTHROPIC_BASE_URL');
  if (url && gatewayHost(url) !== 'api.anthropic.com') setups.push(t(MSG, 'setupGateway', { host: gatewayHost(url) }));
  for (const [key, name] of Object.entries(PROVIDERS)) if (truthy(env[key])) setups.push(t(MSG, 'setupProvider', { name }));
  const setup = setups.join(', ');

  const mapped = Object.fromEntries(aliases.map((a) => [a, ALIAS_VARS[a] ? value(env, ALIAS_VARS[a]) : '']).filter(([, m]) => m));
  const unmapped = aliases.filter((a) => ALIAS_VARS[a] && !mapped[a]);
  if (setup && unmapped.length) {
    warn('alias-unmapped', t(MSG, 'aliasUnmapped', {
      setup,
      aliases: unmapped.join(', '),
      vars: unmapped.map((a) => ALIAS_VARS[a]).join(', '),
    }));
  }

  const byModel = new Map();
  for (const [alias, model] of Object.entries(mapped)) byModel.set(model, [...(byModel.get(model) || []), alias]);
  const groups = [...byModel].filter(([, list]) => list.length > 1).map(([model, list]) => `${list.join(' = ')} → ${model}`);
  if (groups.length) warn('alias-same-model', t(MSG, 'aliasSameModel', { groups: groups.join('; ') }));

  const level = value(env, 'CLAUDE_CODE_EFFORT_LEVEL');
  if (level) warn('effort-forced', t(MSG, 'effortForced', { level }));

  if (issues.length) return issues;
  const list = Object.entries(mapped).map(([a, m]) => `${a} → ${m}`).join(', ');
  let message;
  if (list) message = t(MSG, 'okAliases', { list });
  else message = setup ? t(MSG, 'okSetup', { setup }) : t(MSG, 'okDirect');
  return [{ code: 'ok', level: 'ok', message }];
}
