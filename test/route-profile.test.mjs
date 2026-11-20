import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTable, compareStrength, effectiveTable, loadRouting, mergeTable, parseEntry, resolveRoute } from '../lib/route.mjs';
import { DEFAULT_PROTECTED_FILES, loadProfile } from '../lib/profile.mjs';
import { PLUGIN_ROOT, tempDir, write, writeProfile } from './helpers.mjs';

const routing = loadRouting(PLUGIN_ROOT);

function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const block = text.match(/^---\n([\s\S]*?)\n---/)[1];
  return Object.fromEntries(block.split('\n').map((l) => l.split(/:\s*/, 2)).filter((p) => p.length === 2));
}

test('built-in routing table satisfies every invariant', () => {
  assert.deepEqual(checkTable(routing, mergeTable(routing, {})), []);
});

test('route resolution and agent mapping', () => {
  const { table } = effectiveTable(routing, {});
  assert.deepEqual(resolveRoute(routing, table, 'normal', 'implementer'), {
    role: 'implementer', mode: 'normal', agent: 'forge:implementer', model: 'sonnet', effort: 'high',
  });
  assert.equal(resolveRoute(routing, table, 'eco', 'mechanic').agent, 'forge:implementer');
  assert.equal(resolveRoute(routing, table, 'normal', 'architect').agent, 'main');
  assert.throws(() => resolveRoute(routing, table, 'normal', 'wizard'), /неизвестная роль/);
});

test('profile overrides apply only when invariants hold', () => {
  const ok = effectiveTable(routing, { normal: { implementer: 'opus/medium' } });
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.table.normal.implementer, 'opus/medium');

  const weakReviewer = effectiveTable(routing, { normal: { reviewer: 'haiku/low' } });
  assert.match(weakReviewer.warnings.join(), /reviewer/);
  assert.equal(weakReviewer.table.normal.reviewer, 'opus/high');

  const fableEco = effectiveTable(routing, { eco: { debugger: 'fable/high' } });
  assert.match(fableEco.warnings.join(), /eco/);

  const typo = effectiveTable(routing, { normal: { scout: 'haiku' } });
  assert.ok(typo.warnings.length);
});

test('agent files exist, match the normal-mode table and respect tool limits', () => {
  for (const [role, { agent }] of Object.entries(routing.roles)) {
    if (!agent) continue;
    assert.ok(existsSync(join(PLUGIN_ROOT, 'agents', `${agent}.md`)), `${role} → agents/${agent}.md`);
  }
  for (const agent of ['scout', 'implementer', 'reviewer', 'debugger']) {
    const fm = frontmatter(join(PLUGIN_ROOT, 'agents', `${agent}.md`));
    assert.equal(fm.name, agent);
    assert.equal(`${fm.model}/${fm.effort}`, routing.modes.normal[agent], `${agent} frontmatter vs routing.json`);
  }
  const scoutTools = frontmatter(join(PLUGIN_ROOT, 'agents', 'scout.md')).tools;
  assert.doesNotMatch(scoutTools, /Edit|Write|Bash/);
  const reviewerTools = frontmatter(join(PLUGIN_ROOT, 'agents', 'reviewer.md')).tools;
  assert.doesNotMatch(reviewerTools, /Edit|Write/);
});

test('profile: missing file gives defaults, broken JSON gives defaults plus an error', () => {
  const dir = tempDir();
  const missing = loadProfile(dir);
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.profile.protected_files, DEFAULT_PROTECTED_FILES);

  write(dir, '.forge/profile.json', '{ not json');
  const broken = loadProfile(dir);
  assert.equal(broken.exists, true);
  assert.match(broken.errors[0], /JSON/);
  assert.deepEqual(broken.profile.git.protected_branches, ['main', 'master']);
});

test('profile: merge, validation and protected_files extending the defaults', () => {
  const dir = tempDir();
  writeProfile(dir, {
    commands: { test: 'npm test', lint: { run: 'eslint {files}', ext: ['.ts'] } },
    verify: { steps: ['lint', 'test', 'typecheck'], on_stop: 'full' },
    protected_files: ['config/secrets.json'],
    mode: 'eco',
  });
  const { profile, errors } = loadProfile(dir);
  assert.match(errors.join(), /typecheck/);
  assert.deepEqual(profile.verify.steps, ['lint', 'test']);
  assert.equal(profile.verify.on_stop, 'full');
  assert.equal(profile.mode, 'eco');
  assert.ok(profile.protected_files.includes('.env'));
  assert.ok(profile.protected_files.includes('config/secrets.json'));
});

test('senior routes to the implementer agent, strictly above implementer in every mode', () => {
  const { table } = effectiveTable(routing, {});
  assert.deepEqual(resolveRoute(routing, table, 'normal', 'senior'), {
    role: 'senior', mode: 'normal', agent: 'forge:implementer', model: 'opus', effort: 'high',
  });
  assert.equal(table.eco.senior, 'sonnet/high');
  assert.equal(table.max.senior, 'opus/xhigh');
  for (const mode of ['eco', 'normal', 'max']) {
    assert.ok(compareStrength(routing, parseEntry(table[mode].senior), parseEntry(table[mode].implementer)) > 0, mode);
  }
  assert.equal(effectiveTable(routing, { normal: { scout: 'haiku/medium' } }).table.normal.senior, 'opus/high');
});

test('overrides that break the senior ladder are rejected', () => {
  const flat = effectiveTable(routing, { normal: { senior: 'sonnet/medium' } });
  assert.match(flat.warnings.join(), /senior .* слабее implementer/);
  assert.equal(flat.table.normal.senior, 'opus/high');

  assert.match(effectiveTable(routing, { normal: { implementer: 'opus/xhigh' } }).warnings.join(), /routing\.normal\.senior/);
  assert.match(effectiveTable(routing, { normal: { senior: 'opus/xhigh' } }).warnings.join(), /reviewer .* слабее senior/);
  assert.match(
    effectiveTable(routing, { eco: { senior: 'opus/xhigh', reviewer: 'opus/xhigh' } }).warnings.join(),
    /debugger .* слабее senior/,
  );
});

test('overrides that make implementer equal to senior are kept', () => {
  for (const [mode, implementer] of [['normal', 'opus/high'], ['max', 'opus/xhigh'], ['eco', 'sonnet/high']]) {
    const res = effectiveTable(routing, { [mode]: { implementer } });
    assert.deepEqual(res.warnings, [], mode);
    assert.equal(res.table[mode].implementer, implementer, mode);
  }
});

test('equality boundaries of the senior ladder are valid', () => {
  assert.deepEqual(effectiveTable(routing, { normal: { senior: 'opus/high', reviewer: 'opus/high' } }).warnings, []);
  assert.deepEqual(effectiveTable(routing, { eco: { senior: 'opus/high', reviewer: 'opus/high' } }).warnings, []);
});
