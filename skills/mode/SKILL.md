---
name: mode
description: Show or switch forge's model-routing mode — eco, normal or max — which sets the model and effort used for each subagent role. Use when the user runs /forge:mode.
argument-hint: "[eco|normal|max]"
disable-model-invocation: true
---

# forge:mode

Run `forge mode $ARGUMENTS`. With no argument it shows the current mode.

Show the user the printed table as is, plus one line on what the mode means:

- **eco** — every role one step cheaper, Fable off. For when usage limits are running low.
- **normal** — the default table.
- **max** — every role one step stronger. For hard work where quality matters more than limits.

The mode is stored in `.forge/state.json` and applies to subagents dispatched from now on.
