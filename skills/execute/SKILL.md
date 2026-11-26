---
name: execute
description: Use to carry out an approved forge plan (the one in `forge state get artifacts.plan`) task by task with role subagents, or when the user says to go ahead and implement the plan.
---

# forge:execute

Implementing through role subagents keeps this session's context small and uses the cheapest model that fits each task. Your job here is coordination and verification, not typing code.

## Dispatching a role

Run `forge route <role>`, then call the agent named in `agent=` with `model` and `effort` set to the printed values.

## Steps

1. Get the plan path with `forge state get artifacts.plan`, read the plan, and run `forge state set stage execute`.
2. Pick the ready tasks: unchecked, with all dependencies checked. Ready tasks with disjoint files run in parallel — send those agent calls in one message.
3. For each task, dispatch its role with: the task text, files, check command, the relevant excerpt of the spec (`forge state get artifacts.spec`), the profile's `tdd` setting, and — when running in parallel — which files the other tasks own so it stays out of them.
4. When a report comes back, don't take "done" on faith. If the report doesn't show the check command passing, run the check yourself. Mark the task `[x]` in the plan only after its check passes. If the plan is inside the repository, the `[x]` marks are part of the change and get committed with it.
5. **Failures.** Re-dispatch once one step up the ladder, with the failure output — a stronger model sees what the weaker one missed: `mechanic` → `implementer`, `implementer` → `senior`, `senior` → `senior` (nothing stronger; the log is the new input). Any other role (e.g. `scout`) retries the same role once. If it fails again, dispatch `debugger` with both failure logs. If the debugger can't fix it, stop and tell the user what is blocked and why.
6. When every task is checked, run `forge verify`. Then `forge state set stage review`, and use forge:review — always for tier 3, and for tier 2 unless the user said to skip it.
7. Tell the user what was done: tasks with their status, anything left open.
