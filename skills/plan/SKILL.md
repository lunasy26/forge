---
name: plan
description: Use before writing code for a feature or any change that spans several files or modules, or when the user asks for a plan. Produces a short spec and a task plan in .forge/work/<slug>/ that forge:execute can run. Skip it for one-file fixes, typos and questions.
---

# forge:plan

A written plan with checkable tasks keeps multi-file work from drifting, and lets cheaper models implement tasks in parallel while this session keeps a small context.

## Dispatching a role

Whenever this skill says "dispatch <role>": run `forge route <role>`, then call the agent named in `agent=` with `model` and `effort` set to the printed values. If `agent=main`, do that part yourself.

## Steps

1. **Gather context cheaply.** Dispatch `scout` with focused questions — one scout per independent area, in parallel. Don't read many files yourself; you need conclusions, not file contents.
2. **Clarify.** Ask the user only questions whose answers change the design — at most three, in one message. If nothing blocks you, state your assumptions instead of asking.
3. **Spec.** Pick a kebab-case slug and write `.forge/work/<slug>/spec.md`, at most ~40 lines: goal, in scope / out of scope, decisions with one-line reasons, acceptance criteria.
4. **Plan.** Write `.forge/work/<slug>/plan.md` with tasks in exactly this format:

   ```markdown
   - [ ] T1 <imperative title>
     role: implementer
     files: src/a.ts, src/a.spec.ts
     check: npm test -- a.spec
     depends: -
   ```

   - `role` is `implementer`, `mechanic` (mechanical edits with exact instructions) or `scout`.
   - Each task fits in one implementer run — roughly five files or fewer.
   - Every task has a `check` command that proves it is done.
   - Tasks with disjoint `files` and no dependency between them can run in parallel; say which groups in a line at the top of the plan.
   - If `.forge/profile.json` has `"tdd": "required"`, test tasks come before the tasks that implement the behaviour.
5. **Record state** in one command:
   `forge state set task.slug <slug> stage plan tier 2 artifacts.spec .forge/work/<slug>/spec.md artifacts.plan .forge/work/<slug>/plan.md`
   Use `tier 3` instead if the work touches the profile's `risky_paths` (migrations, auth, CI and the like).
6. **Get a go-ahead.** Show the user the task titles with roles and parallel groups, and ask before executing. When they agree, use forge:execute.
