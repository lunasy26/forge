import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTable, effectiveTable, loadRouting, mergeTable, resolveRoute } from '../lib/route.mjs';
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
