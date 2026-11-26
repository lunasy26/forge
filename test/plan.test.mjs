import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTask, parsePlan, planProgress } from '../lib/plan.mjs';
import { tempDir, write } from './helpers.mjs';

const PLAN = `Parallel groups: T2 and T3.

- [x] T1 Add the parser
  role: implementer
  files: lib/a.mjs
  check: npm test
  depends: -

- [ ] T2 Wire the hook
  role: implementer
  depends: T4

- [ ] T3: Write the docs
  depends: T1

- [ ] T4
  depends: T1, T3

\`\`\`markdown
- [ ] T9 an example inside a code block
\`\`\`
`;

test('parsePlan: ids, titles, checkboxes and depends; code blocks skipped', () => {
  const tasks = parsePlan(PLAN);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.title, t.done, t.depends]),
    [
      ['T1', 'Add the parser', true, []],
      ['T2', 'Wire the hook', false, ['T4']],
      ['T3', 'Write the docs', false, ['T1']],
      ['T4', '', false, ['T1', 'T3']],
    ],
  );
  assert.deepEqual(parsePlan('- [X] T1 done\r\n- [ ] T2 open\r\n').map((t) => t.done), [true, false]);
  assert.deepEqual(parsePlan('# Plan\n\n- [ ] not a task id\n* [ ] Tx neither\n'), []);
});

test('parsePlan: a depends line belongs only to its own task block', () => {
  const tasks = parsePlan('- [ ] T1 a\n\nNotes:\n  depends: T7\n- [ ] T2 b\n');
  assert.deepEqual(tasks.map((t) => t.depends), [[], []]);
});

test('nextTask: first ready task, else the first open one, else null', () => {
  const tasks = parsePlan(PLAN);
  assert.equal(nextTask(tasks).id, 'T3'); // T2 waits for T4, T3 only needs T1
  assert.equal(nextTask(parsePlan('- [ ] T1 a\n  depends: T2\n- [ ] T2 b\n  depends: T1\n')).id, 'T1');
  assert.equal(nextTask(parsePlan('- [x] T1 a\n- [x] T2 b\n')), null);
  assert.equal(nextTask([]), null);
});

test('planProgress: counts and next task; null for a missing, empty or task-less plan', () => {
  const dir = tempDir();
  write(dir, '.forge/work/x/plan.md', PLAN);
  const p = planProgress(dir, '.forge/work/x/plan.md');
  assert.equal(p.total, 4);
  assert.equal(p.done, 1);
  assert.equal(p.next.id, 'T3');
  assert.equal(planProgress(dir, '.forge/work/missing/plan.md'), null);
  assert.equal(planProgress(dir, '.forge/work'), null); // a directory
  assert.equal(planProgress(dir, ''), null);
  assert.equal(planProgress(dir, undefined), null);
  write(dir, 'notes.md', '# nothing here\n');
  assert.equal(planProgress(dir, 'notes.md'), null);
  write(dir, 'big.md', '- [ ] T1 a\n' + 'x'.repeat(300 * 1024));
  assert.equal(planProgress(dir, 'big.md'), null);
});
