import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORK, WORK_PRESETS, defaultProfile, loadProfile, validateProfile, workPaths,
} from '../lib/profile.mjs';
import { tempDir, writeProfile } from './helpers.mjs';

const DEF = { spec: '.forge/work/{slug}/spec.md', plan: '.forge/work/{slug}/plan.md' };
const load = (profile) => {
  const dir = tempDir();
  writeProfile(dir, profile);
  return loadProfile(dir);
};

test('work: defaults when the field is absent', () => {
  assert.deepEqual(defaultProfile().work, DEF);
  assert.deepEqual(DEFAULT_WORK, DEF);
  assert.deepEqual(WORK_PRESETS.local, DEF);
  assert.deepEqual(WORK_PRESETS.docs, { spec: 'docs/specs/{slug}.md', plan: 'docs/plans/{slug}.md' });
  const { profile, errors } = load({});
  assert.deepEqual(profile.work, DEF);
  assert.deepEqual(errors, []);
});

test('work: the default cannot be mutated through a profile', () => {
  const p = defaultProfile();
  p.work.spec = 'changed/{slug}.md';
  assert.deepEqual(defaultProfile().work, DEF);
  assert.deepEqual(DEFAULT_WORK, DEF);
  assert.throws(() => { DEFAULT_WORK.spec = 'x'; });
  const loaded = load({ work: { spec: 'a/{slug}.md', plan: 'b/{slug}.md' } });
  assert.equal(loaded.profile.work.spec, 'a/{slug}.md');
  assert.deepEqual(DEFAULT_WORK, DEF);
});

test('work: valid custom templates are applied', () => {
  const work = { spec: 'docs/specs/{date}-{slug}.md', plan: 'docs\\plans\\{slug}.md' };
  assert.deepEqual(validateProfile({ work }), []);
  const { profile, errors } = load({ work });
  assert.deepEqual(errors, []);
  assert.deepEqual(profile.work, work);
  assert.deepEqual(load({ work: WORK_PRESETS.docs }).profile.work, WORK_PRESETS.docs);
  // one key only: the other keeps its default
  const one = load({ work: { plan: 'plans/{slug}.md' } });
  assert.deepEqual(one.errors, []);
  assert.deepEqual(one.profile.work, { spec: DEF.spec, plan: 'plans/{slug}.md' });
});

const INVALID = {
  'a non-string': 5,
  'an empty string': '',
  'a blank string': '   ',
  'a space': 'my docs/{slug}.md',
  'a tab': 'docs/{slug}\t.md',
  'a trailing newline': 'docs/{slug}.md\n',
  'a single quote': "docs/it's/{slug}.md",
  'no {slug}': 'docs/spec.md',
  'an unknown placeholder': 'docs/{x}/{slug}.md',
  'an unknown placeholder next to {slug}': 'docs/{slug}-{name}.md',
  'an absolute path': '/a/{slug}.md',
  'a backslash root': '\\a\\{slug}.md',
  'a drive letter': 'C:\\a\\{slug}.md',
  'a .. segment': 'docs/../x/{slug}.md',
  'a .. segment with backslashes': 'docs\\..\\{slug}.md',
};

for (const key of ['spec', 'plan']) {
  const other = key === 'spec' ? 'plan' : 'spec';
  for (const [name, value] of Object.entries(INVALID)) {
    test(`work.${key}: ${name} is an error and falls back to the default`, () => {
      const errs = validateProfile({ work: { [key]: value } });
      assert.equal(errs.length, 1, errs.join('; '));
      assert.ok(errs[0].startsWith(`work.${key}:`), errs[0]);
      const okOther = `ok/{slug}-${other}.md`;
      const { profile, errors } = load({ work: { [key]: value, [other]: okOther } });
      assert.equal(errors.length, 1);
      assert.equal(profile.work[key], DEF[key]);
      assert.equal(profile.work[other], okOther);
    });
  }
}

test('work: names with a double dot inside a segment are allowed', () => {
  assert.deepEqual(validateProfile({ work: { spec: 'docs/a..b/{slug}.md' } }), []);
});

test('work: spec equal to plan reports an error and both fall back', () => {
  const same = { spec: 'docs/{slug}.md', plan: 'docs/{slug}.md' };
  const errs = validateProfile({ work: same });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /work\.spec.*work\.plan/);
  const { profile, errors } = load({ work: same });
  assert.equal(errors.length, 1);
  assert.deepEqual(profile.work, DEF);
  // a custom value that collides with the other key's default
  const clash = load({ work: { spec: DEF.plan } });
  assert.equal(clash.errors.length, 1);
  assert.deepEqual(clash.profile.work, DEF);
});

test('work: spec equal to plan after normalisation is an error and both fall back', () => {
  for (const plan of ['./docs/{slug}.md', 'docs\\{slug}.md', 'Docs/{slug}.md', 'docs//{slug}.md', './DOCS\\.\\{slug}.md']) {
    const same = { spec: 'docs/{slug}.md', plan };
    const errs = validateProfile({ work: same });
    assert.equal(errs.length, 1, plan);
    assert.match(errs[0], /work\.spec.*work\.plan/);
    const { profile, errors } = load({ work: same });
    assert.equal(errors.length, 1, plan);
    assert.deepEqual(profile.work, DEF);
  }
  // genuinely different paths are fine
  assert.deepEqual(validateProfile({ work: { spec: 'docs/a/{slug}.md', plan: 'docs/b/{slug}.md' } }), []);
  assert.deepEqual(validateProfile({ work: { spec: 'docs/{slug}-spec.md', plan: 'docs/{slug}-plan.md' } }), []);
});

test('work: a non-object is an error and defaults stay', () => {
  for (const bad of ['docs', 5, [], null, true]) {
    const errs = validateProfile({ work: bad });
    assert.equal(errs.length, 1);
    assert.ok(errs[0].startsWith('work:'), errs[0]);
    const { profile, errors } = load({ work: bad });
    assert.equal(errors.length, 1);
    assert.deepEqual(profile.work, DEF);
  }
});

test('workPaths substitutes {slug} and {date}', () => {
  const date = new Date(2026, 0, 5);
  assert.deepEqual(workPaths(DEFAULT_WORK, 'login', date), {
    spec: '.forge/work/login/spec.md',
    plan: '.forge/work/login/plan.md',
  });
  assert.deepEqual(
    workPaths({ spec: 'docs/{date}/{slug}/{slug}-spec.md', plan: '{date}-{date}-{slug}.md' }, 'x', date),
    { spec: 'docs/2026-01-05/x/x-spec.md', plan: '2026-01-05-2026-01-05-x.md' },
  );
  // local date, zero-padded
  assert.equal(workPaths({ spec: '{date}/{slug}', plan: 'p' }, 's', new Date(2026, 11, 31, 23, 59)).spec, '2026-12-31/s');
  assert.equal(workPaths({ spec: '{date}/{slug}', plan: 'p' }, 's', new Date(2026, 8, 9, 0, 1)).spec, '2026-09-09/s');
  // the default date is today
  assert.match(workPaths({ spec: '{date}/{slug}', plan: 'p' }, 's').spec, /^\d{4}-\d{2}-\d{2}\/s$/);
});

test('workPaths returns forward slashes', () => {
  const date = new Date(2026, 0, 5);
  assert.deepEqual(
    workPaths({ spec: 'docs\\specs\\{date}\\{slug}.md', plan: 'docs\\plans\\{slug}.md' }, 'x', date),
    { spec: 'docs/specs/2026-01-05/x.md', plan: 'docs/plans/x.md' },
  );
});

test('workPaths inserts the slug literally', () => {
  const work = { spec: 'a/{slug}.md', plan: 'b/{slug}.md' };
  for (const slug of ['x$&y', 'x$$y', 'x$`y', "x$'y", 'x$1y', 'x{date}y']) {
    assert.deepEqual(workPaths(work, slug), { spec: `a/${slug}.md`, plan: `b/${slug}.md` });
  }
});
