import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, runCli as run, write, writeProfile } from './helpers.mjs';

const runCli = (args, opts = {}) => run(args, { ...opts, env: { FORGE_LANG: 'ru', ...opts.env } });
const readProfile = (dir) => JSON.parse(readFileSync(join(dir, '.forge', 'profile.json'), 'utf8'));

test('work: default paths without a profile and with a default profile', () => {
  const dir = gitRepo();
  const none = runCli(['work', 'demo'], { cwd: dir });
  assert.equal(none.code, 0, none.stderr);
  assert.equal(none.stdout.trim(), 'spec=.forge/work/demo/spec.md plan=.forge/work/demo/plan.md');
  writeProfile(dir, {});
  assert.equal(runCli(['work', 'demo'], { cwd: dir }).stdout.trim(), 'spec=.forge/work/demo/spec.md plan=.forge/work/demo/plan.md');
});

test('work: custom templates with {date} and --json', () => {
  const dir = gitRepo();
  writeProfile(dir, { work: { spec: 'docs/{date}-{slug}.md', plan: 'docs/plans/{date}-{slug}-plan.md' } });
  const r = runCli(['work', 'add-login', '--json'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const { spec, plan } = JSON.parse(r.stdout);
  assert.match(spec, /^docs\/\d{4}-\d{2}-\d{2}-add-login\.md$/);
  assert.match(plan, /^docs\/plans\/\d{4}-\d{2}-\d{2}-add-login-plan\.md$/);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['spec', 'plan']);
});

test('work: the slug may come after --json', () => {
  const dir = gitRepo();
  const r = runCli(['work', '--json', 'demo'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).spec, '.forge/work/demo/spec.md');
});

test('work: bad or missing slug exits 2', () => {
  const dir = gitRepo();
  for (const args of [['work', 'Demo'], ['work', 'a_b'], ['work', '-x'], ['work', 'a--b'], ['work', '../x'], ['work'], ['work', '--json']]) {
    const r = runCli(args, { cwd: dir });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /forge: /);
    assert.equal(r.stdout, '');
  }
  assert.match(runCli(['work', 'Demo'], { cwd: dir }).stderr, /некорректный slug «Demo»/);
  assert.match(runCli(['work'], { cwd: dir }).stderr, /укажи slug/);
});

test('work: English messages', () => {
  const dir = gitRepo();
  const env = { FORGE_LANG: 'en' };
  assert.match(runCli(['work', 'Demo'], { cwd: dir, env }).stderr, /invalid slug "Demo"/);
  assert.match(runCli(['work'], { cwd: dir, env }).stderr, /specify a feature slug/);
  assert.match(runCli(['init', '--work', 'bogus'], { cwd: dir, env }).stderr, /--work takes local or docs \(got "bogus"\)/);
});

test('init: always proposes work, local by default', () => {
  const dir = gitRepo();
  const r = runCli(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"work": \{\s*"spec": "\.forge\/work\/\{slug\}\/spec\.md"/);
  assert.doesNotMatch(r.stdout, /forge init --work local/);
});

test('init: docs/plans/ proposes docs templates and a note', () => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  const r = runCli(['init'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"spec": "docs\/specs\/\{slug\}\.md"/);
  assert.match(r.stdout, /"plan": "docs\/plans\/\{slug\}\.md"/);
  assert.match(r.stdout, /найден docs\/plans\/ — спеки и планы будут записываться в репозиторий/);
  assert.equal(existsSync(join(dir, '.forge', 'profile.json')), false);
});

test('init: docs/specs/ alone also counts; a file named docs/plans does not', () => {
  const a = gitRepo();
  mkdirSync(join(a, 'docs', 'specs'), { recursive: true });
  assert.match(runCli(['init'], { cwd: a }).stdout, /"spec": "docs\/specs\/\{slug\}\.md"/);
  const b = gitRepo();
  write(b, 'docs/plans', 'not a directory');
  const r = runCli(['init'], { cwd: b });
  assert.match(r.stdout, /"spec": "\.forge\/work\/\{slug\}\/spec\.md"/);
  assert.doesNotMatch(r.stdout, /найден docs/);
});

test('init --work docs --yes writes docs templates', () => {
  const dir = gitRepo();
  const r = runCli(['init', '--work', 'docs', '--yes'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readProfile(dir).work, { spec: 'docs/specs/{slug}.md', plan: 'docs/plans/{slug}.md' });
  assert.equal(runCli(['work', 'demo'], { cwd: dir }).stdout.trim(), 'spec=docs/specs/demo.md plan=docs/plans/demo.md');
});

test('init --yes --work docs: flag order does not matter', () => {
  const dir = gitRepo();
  assert.equal(runCli(['init', '--yes', '--work', 'docs'], { cwd: dir }).code, 0);
  assert.equal(readProfile(dir).work.spec, 'docs/specs/{slug}.md');
});

test('init --work=local --yes in a repo with docs/plans/ writes local defaults', () => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  const r = runCli(['init', '--work=local', '--yes'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readProfile(dir).work, { spec: '.forge/work/{slug}/spec.md', plan: '.forge/work/{slug}/plan.md' });
});

test('init --work docs previews docs templates', () => {
  const dir = gitRepo();
  const r = runCli(['init', '--work=docs'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"spec": "docs\/specs\/\{slug\}\.md"/);
});

test('init --work with a bad or missing value exits 2 and writes nothing', () => {
  const dir = gitRepo();
  for (const args of [['init', '--work', 'bogus'], ['init', '--work=bogus', '--yes'], ['init', '--work'], ['init', '--work', '--yes'], ['init', '--work=', '--yes']]) {
    const r = runCli(args, { cwd: dir });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /--work принимает local или docs/);
  }
  assert.equal(existsSync(join(dir, '.forge', 'profile.json')), false);
});
