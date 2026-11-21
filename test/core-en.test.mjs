import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getLang, setLang } from '../lib/i18n.mjs';
import { defaultProfile, loadProfile, validateProfile, versionFileError } from '../lib/profile.mjs';
import { checkTable, effectiveTable, loadRouting, mergeTable, resolveRoute } from '../lib/route.mjs';
import { runSteps, summarize, failureReport } from '../lib/verify.mjs';
import { validateStateValue } from '../lib/state.mjs';
import { trimOutput } from '../lib/util.mjs';
import { detectProfile, detectRelease } from '../lib/detect.mjs';
import { bumpVersion, compareVersions } from '../lib/semver.mjs';
import { tempDir, write } from './helpers.mjs';

const CYRILLIC = /\p{Script=Cyrillic}/u;

let before;
beforeEach(() => {
  before = getLang();
  setLang('en');
});
afterEach(() => setLang(before));

test('en: profile validation errors are English', () => {
  const errors = validateProfile({ mode: 'turbo', verify: { timeout_sec: 0, steps: ['x'] }, docs: [], release: { version_files: [{ path: 'a' }] } });
  assert.ok(errors.includes('mode: one of eco, normal, max'));
  assert.ok(errors.includes('verify.timeout_sec: an integer from 1 to 540'));
  assert.ok(errors.includes('verify.steps: step "x" is not defined in commands'));
  assert.ok(errors.includes('docs: an object is expected'));
  assert.ok(errors.includes('release.version_files[0]: pattern: a non-empty string (regular expression)'));
  assert.deepEqual(validateProfile([]), ['the profile must be a JSON object']);
  assert.equal(errors.filter((e) => CYRILLIC.test(e)).length, 0);
  assert.equal(versionFileError(''), 'the path must not be empty');
});

test('en: loadProfile reports invalid JSON in English', () => {
  const root = tempDir();
  write(root, '.forge/profile.json', '{ nope');
  const { errors } = loadProfile(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^profile\.json: invalid JSON \(/);
  assert.doesNotMatch(errors[0], CYRILLIC);
});

test('en: routing invariants and errors are English', () => {
  const routing = loadRouting();
  const table = mergeTable(routing, { eco: { implementer: 'fable/high', reviewer: 'sonnet/low', bogus: 'x/y' } });
  const errors = checkTable(routing, table);
  assert.ok(errors.some((e) => /^eco\.bogus: unknown role$/.test(e)));
  assert.ok(errors.includes('eco.implementer: fable is not allowed in eco mode'));
  assert.ok(errors.some((e) => /reviewer \(.+\) is weaker than implementer/.test(e)));
  const senior = checkTable(routing, mergeTable(routing, { normal: { implementer: 'opus/high', senior: 'sonnet/low' } }));
  assert.ok(senior.some((e) => /^normal: senior \(sonnet\/low\) is weaker than implementer \(opus\/high\) — raise routing\.normal\.senior/.test(e)), senior.join('\n'));
  const { warnings } = effectiveTable(routing, { eco: { reviewer: 'nope' } });
  assert.ok(warnings.length > 0);
  assert.equal(warnings.filter((w) => CYRILLIC.test(w)).length, 0);
  assert.throws(() => resolveRoute(routing, mergeTable(routing, {}), 'normal', 'nobody'), /^Error: unknown role "nobody"\. Roles: /);
});

test('en: verify summaries and failure report are English', () => {
  const profile = defaultProfile();
  profile.commands = { ok: 'true', bad: 'echo boom; exit 3', file: 'echo {files}' };
  const result = runSteps(tempDir(), profile, ['ok', 'file', 'bad']);
  assert.match(summarize(result), /^ok: ok \(\d+\.\d s\), file: skipped, bad: code 3$/);
  assert.equal(failureReport(result), 'Step "bad" failed (code 3): `echo boom; exit 3`\nboom');
  assert.equal(summarize({ results: [] }), 'no steps');
  const late = runSteps(tempDir(), profile, ['ok'], { timeoutSec: -1 });
  assert.equal(late.failed.output, 'ran out of time (verify.timeout_sec)');
  assert.match(failureReport(late), /failed \(timeout\)/);
});

test('en: state validation and trimOutput messages are English', () => {
  assert.equal(validateStateValue('tier', 9), 'tier: an integer 0-3');
  assert.equal(validateStateValue('stage', 'x'), 'stage: one of spec, plan, execute, review, finish or null');
  assert.equal(validateStateValue('mode', 'x'), 'mode: one of eco, normal, max or null');
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  assert.match(trimOutput(text, 20), /\n… \(81 lines hidden\)\n/);
});

test('en: semver errors are English', () => {
  assert.throws(() => bumpVersion('1.0', 'patch'), /^Error: not a semver version: 1\.0$/);
  assert.throws(() => bumpVersion('1.0.0', 'huge'), /^Error: unknown version bump level: huge$/);
  assert.throws(() => compareVersions('v2', '1.0.0'), /^Error: not a semver version: v2$/);
});

test('en: init notes are English', () => {
  const root = tempDir();
  write(root, 'package.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  write(root, 'go.mod', 'module x\n');
  write(root, '.github/workflows/ci.yml', 'jobs:\n  a:\n    steps:\n      - run: npm publish\n');
  const { notes } = detectProfile(root);
  assert.ok(notes.includes('package.json has no test script — set commands.test manually if there are tests.'));
  assert.ok(notes.some((n) => /^Another stack found: go\. The profile only describes node \(npm\);/.test(n)));
  assert.ok(notes.includes('Releases enabled: CI publishes packages (npm publish).'));
  assert.ok(notes.includes('Version in package.json: 1.2.3.'));
  assert.equal(notes.filter((n) => CYRILLIC.test(n)).length, 0);
  assert.deepEqual(detectRelease(tempDir()), { release: null, notes: [] });
  assert.deepEqual(detectProfile(tempDir()).notes, ['Stack not recognized — describe commands manually.']);
});
