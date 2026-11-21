import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../lib/i18n.mjs';
import { checkModels, modelEnv, tableAliases } from '../lib/models.mjs';
import { effectiveTable, loadRouting } from '../lib/route.mjs';
import { settingsEnv } from '../lib/settings.mjs';
import { PLUGIN_ROOT, emptyConfigDir, tempDir, write } from './helpers.mjs';

setLang('ru'); // assertions below check the Russian texts unless a test switches the language
afterEach(() => setLang('ru'));

const ALL = ['haiku', 'sonnet', 'opus', 'fable'];
const MAPPED = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm-small',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'm-medium',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'm-large',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'm-huge',
};
const codes = (env, aliases = ALL) => checkModels({ env, aliases }).map((i) => i.code);
const find = (env, code, aliases = ALL) => checkModels({ env, aliases }).find((i) => i.code === code);

// ---- subagent-forced ----

test('subagent-forced: warns for 1, true, yes in any case, with the forced model', () => {
  for (const v of ['1', 'true', 'TRUE', 'Yes', ' yes ']) {
    const issue = find({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v, CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, 'subagent-forced');
    assert.ok(issue, v);
    assert.equal(issue.level, 'warn');
    assert.match(issue.message, /haiku/);
  }
});

test('subagent-forced: silent for 0, false, empty or without FORCE (the model alone is only a default)', () => {
  for (const env of [
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' },
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'false' },
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' },
  ]) assert.ok(!codes(env).includes('subagent-forced'), JSON.stringify(env));
});

test('subagent-forced: warns even when the model is not set', () => {
  assert.ok(find({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, 'subagent-forced'));
});

// ---- alias-unmapped ----

test('alias-unmapped: gateway without mappings lists every alias in one issue', () => {
  const issues = checkModels({ env: { ANTHROPIC_BASE_URL: 'https://llm.example.com/v1' }, aliases: ['sonnet', 'opus'] });
  assert.deepEqual(issues.map((i) => i.code), ['alias-unmapped']);
  assert.equal(issues[0].level, 'warn');
  assert.match(issues[0].message, /sonnet, opus/);
  assert.match(issues[0].message, /ANTHROPIC_DEFAULT_SONNET_MODEL/);
  assert.match(issues[0].message, /ANTHROPIC_DEFAULT_OPUS_MODEL/);
  assert.match(issues[0].message, /llm\.example\.com/);
});

test('alias-unmapped: only the unmapped aliases are listed', () => {
  const env = { ANTHROPIC_BASE_URL: 'https://llm.example.com', ANTHROPIC_DEFAULT_SONNET_MODEL: 'm-medium' };
  const issue = find(env, 'alias-unmapped', ['sonnet', 'opus']);
  assert.match(issue.message, /opus/);
  assert.doesNotMatch(issue.message, /ANTHROPIC_DEFAULT_SONNET_MODEL/);
});

test('alias-unmapped: direct Anthropic does not need mappings', () => {
  assert.ok(!codes({}).includes('alias-unmapped'));
  assert.ok(!codes({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }).includes('alias-unmapped'));
  assert.ok(!codes({ ANTHROPIC_BASE_URL: 'https://API.Anthropic.com:443/v1' }).includes('alias-unmapped'));
});

test('alias-unmapped: a gateway or provider with every alias mapped is fine', () => {
  assert.deepEqual(codes({ ANTHROPIC_BASE_URL: 'https://llm.example.com', ...MAPPED }), ['ok']);
  assert.deepEqual(codes({ CLAUDE_CODE_USE_BEDROCK: '1', ...MAPPED }), ['ok']);
});

test('alias-unmapped: each provider flag counts, falsy flags do not', () => {
  for (const [flag, name] of [['CLAUDE_CODE_USE_BEDROCK', 'Bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'Vertex'], ['CLAUDE_CODE_USE_FOUNDRY', 'Foundry']]) {
    const issue = find({ [flag]: '1' }, 'alias-unmapped');
    assert.ok(issue, flag);
    assert.match(issue.message, new RegExp(name));
    assert.ok(!codes({ [flag]: '0' }).includes('alias-unmapped'), flag);
  }
});

test('alias-unmapped: an unparseable base URL still counts as a gateway', () => {
  assert.ok(find({ ANTHROPIC_BASE_URL: 'not a url' }, 'alias-unmapped'));
});

// ---- alias-same-model ----

test('alias-same-model: two aliases on one model', () => {
  const env = { ...MAPPED, ANTHROPIC_DEFAULT_OPUS_MODEL: 'm-medium' };
  const issue = find(env, 'alias-same-model');
  assert.equal(issue.level, 'warn');
  assert.match(issue.message, /sonnet = opus → m-medium/);
});

test('alias-same-model: also on direct Anthropic; distinct models and unmapped aliases are fine', () => {
  assert.ok(find({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'x', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x' }, 'alias-same-model'));
  assert.ok(!codes(MAPPED).includes('alias-same-model'));
  assert.ok(!codes({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' }).includes('alias-same-model'));
});

test('alias-same-model: only aliases of the current table are compared', () => {
  const env = { ANTHROPIC_DEFAULT_FABLE_MODEL: 'x', ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' };
  assert.ok(find(env, 'alias-same-model', ALL));
  assert.ok(!codes(env, ['haiku', 'sonnet', 'opus']).includes('alias-same-model'));
});

// ---- effort-forced ----

test('effort-forced: warns when CLAUDE_CODE_EFFORT_LEVEL is set, silent otherwise', () => {
  const issue = find({ CLAUDE_CODE_EFFORT_LEVEL: 'low' }, 'effort-forced');
  assert.equal(issue.level, 'warn');
  assert.match(issue.message, /low/);
  assert.ok(!codes({}).includes('effort-forced'));
  assert.ok(!codes({ CLAUDE_CODE_EFFORT_LEVEL: '' }).includes('effort-forced'));
});

// ---- ok ----

test('ok: direct Anthropic without mappings', () => {
  const issues = checkModels({ env: {}, aliases: ALL });
  assert.deepEqual(issues.map((i) => [i.code, i.level]), [['ok', 'ok']]);
  assert.match(issues[0].message, /^Модели: Anthropic напрямую$/);
});

test('ok: the mapped aliases are described', () => {
  const issues = checkModels({ env: { ANTHROPIC_BASE_URL: 'https://llm.example.com', ...MAPPED }, aliases: ['sonnet', 'opus'] });
  assert.deepEqual(issues.map((i) => i.code), ['ok']);
  assert.match(issues[0].message, /^Модели: псевдонимы sonnet → m-medium, opus → m-large$/);
});

test('warnings replace the ok line and several can combine', () => {
  const env = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'true', ANTHROPIC_BASE_URL: 'https://llm.example.com', CLAUDE_CODE_EFFORT_LEVEL: 'high' };
  assert.deepEqual(codes(env), ['subagent-forced', 'alias-unmapped', 'effort-forced']);
});

test('no aliases and no env: ok', () => {
  assert.deepEqual(codes({}, []), ['ok']);
});

// ---- aliases from the current mode ----

test('tableAliases: distinct models of the current mode only (eco has no fable)', () => {
  const routing = loadRouting(PLUGIN_ROOT);
  const { table } = effectiveTable(routing, {});
  const eco = tableAliases(routing, table, 'eco');
  assert.ok(!eco.includes('fable'));
  assert.deepEqual(eco, ['haiku', 'sonnet', 'opus']);
  assert.ok(tableAliases(routing, table, 'normal').includes('fable'));
  assert.equal(new Set(eco).size, eco.length);
});

test('a gateway without a fable mapping is fine in eco, a problem in normal', () => {
  const routing = loadRouting(PLUGIN_ROOT);
  const { table } = effectiveTable(routing, {});
  const env = { ANTHROPIC_BASE_URL: 'https://llm.example.com', ...MAPPED, ANTHROPIC_DEFAULT_FABLE_MODEL: '' };
  assert.deepEqual(codes(env, tableAliases(routing, table, 'eco')), ['ok']);
  const issue = find(env, 'alias-unmapped', tableAliases(routing, table, 'normal'));
  assert.match(issue.message, /fable/);
});

// ---- settings env merged under process env ----

function project() {
  const configDir = emptyConfigDir();
  const root = tempDir('forge-models-');
  return { configDir, root, env: { CLAUDE_CONFIG_DIR: configDir } };
}

test('settingsEnv: later files override earlier ones; non-strings and unreadable files are ignored', () => {
  const { configDir, root, env } = project();
  write(configDir, 'settings.json', { env: { A: 'user', B: 'user', C: 'user', N: 1, O: { x: 1 } } });
  write(root, '.claude/settings.json', { env: { B: 'project', C: 'project' } });
  write(root, '.claude/settings.local.json', { env: { C: 'local' } });
  assert.deepEqual(settingsEnv(root, env), { A: 'user', B: 'project', C: 'local' });
  write(root, '.claude/settings.local.json', '{ broken');
  assert.deepEqual(settingsEnv(root, env), { A: 'user', B: 'project', C: 'project' });
  write(configDir, 'settings.json', { env: ['x'] });
  assert.deepEqual(settingsEnv(root, env), { B: 'project', C: 'project' });
});

test('modelEnv: settings env is read from the given config dir, restricted to model keys', () => {
  const { configDir, root, env } = project();
  write(configDir, 'settings.json', { env: { ANTHROPIC_BASE_URL: 'https://user.example.com', SECRET_TOKEN: 'x', CLAUDE_CODE_EFFORT_LEVEL: 'low' } });
  assert.deepEqual(modelEnv(root, env), { ANTHROPIC_BASE_URL: 'https://user.example.com', CLAUDE_CODE_EFFORT_LEVEL: 'low' });
});

test('modelEnv: precedence is process env over project local over project over user settings', () => {
  const { configDir, root, env } = project();
  write(configDir, 'settings.json', { env: { ANTHROPIC_BASE_URL: 'https://user.example.com', CLAUDE_CODE_SUBAGENT_MODEL: 'user', CLAUDE_CODE_EFFORT_LEVEL: 'user', CLAUDE_CODE_USE_VERTEX: 'user' } });
  write(root, '.claude/settings.json', { env: { ANTHROPIC_BASE_URL: 'https://project.example.com', CLAUDE_CODE_SUBAGENT_MODEL: 'project', CLAUDE_CODE_EFFORT_LEVEL: 'project' } });
  write(root, '.claude/settings.local.json', { env: { ANTHROPIC_BASE_URL: 'https://local.example.com', CLAUDE_CODE_SUBAGENT_MODEL: 'local' } });
  const merged = modelEnv(root, { ...env, CLAUDE_CODE_SUBAGENT_MODEL: 'process' });
  assert.equal(merged.ANTHROPIC_BASE_URL, 'https://local.example.com');
  assert.equal(merged.CLAUDE_CODE_SUBAGENT_MODEL, 'process');
  assert.equal(merged.CLAUDE_CODE_EFFORT_LEVEL, 'project');
  assert.equal(merged.CLAUDE_CODE_USE_VERTEX, 'user');
});

test('modelEnv + checkModels: warnings come from settings files alone', () => {
  const { root, env } = project();
  write(root, '.claude/settings.local.json', { env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ANTHROPIC_BASE_URL: 'https://llm.example.com' } });
  assert.deepEqual(codes(modelEnv(root, env)), ['subagent-forced', 'alias-unmapped']);
});

test('modelEnv: a process variable can switch off what a settings file turned on', () => {
  const { root, env } = project();
  write(root, '.claude/settings.json', { env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } });
  assert.ok(codes(modelEnv(root, env)).includes('subagent-forced'));
  assert.ok(!codes(modelEnv(root, { ...env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0' })).includes('subagent-forced'));
});

// ---- English ----

test('English rendering', () => {
  setLang('en');
  assert.equal(checkModels({ env: {}, aliases: ALL })[0].message, 'Models: Anthropic directly');
  assert.equal(
    checkModels({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'm-medium' }, aliases: ['sonnet'] })[0].message,
    'Models: aliases sonnet → m-medium',
  );
  const all = checkModels({
    env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_EFFORT_LEVEL: 'low', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x', ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' },
    aliases: ['haiku', 'sonnet', 'opus'],
  });
  assert.deepEqual(all.map((i) => i.code), ['subagent-forced', 'alias-unmapped', 'alias-same-model', 'effort-forced']);
  assert.match(all[0].message, /every subagent runs on one model \(haiku\)/);
  assert.match(all[1].message, /provider Bedrock without a mapping for aliases opus/);
  assert.match(all[2].message, /haiku = sonnet → x/);
  assert.match(all[3].message, /CLAUDE_CODE_EFFORT_LEVEL=low/);
  for (const i of all) assert.doesNotMatch(i.message, /\p{Script=Cyrillic}/u);
});

test('Russian rendering of the warnings', () => {
  setLang('ru');
  const all = checkModels({
    env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ANTHROPIC_BASE_URL: 'https://llm.example.com', CLAUDE_CODE_EFFORT_LEVEL: 'low' },
    aliases: ['opus'],
  });
  assert.match(all[0].message, /все субагенты на одной модели \(CLAUDE_CODE_SUBAGENT_MODEL не задана\)/);
  assert.match(all[1].message, /шлюз llm\.example\.com, но для псевдонимов opus нет отображения/);
  assert.match(all[2].message, /effort из таблицы forge не применяется/);
});
