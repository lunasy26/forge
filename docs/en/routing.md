**English** · [Русский](../ru/routing.md)

← [README](../../README.md)

# Model routing

Each role gets a model and effort from the current mode's table. forge doesn't touch the main session: its model is the user's choice. Roles are dispatched by the skills [`/forge:plan`, `/forge:execute`, `/forge:review` and `/forge:docs`](skills.md); the agents themselves are Claude Code [subagents](https://code.claude.com/docs/en/sub-agents).

**On this page:**

- [Roles](#roles)
- [Models by mode](#models-by-mode)
- [How skills dispatch a role](#how-skills-dispatch-a-role)
- [Retry ladder](#retry-ladder)
- [Invariants](#invariants)
- [Routing overrides](#routing-overrides)
- [Using other models](#using-other-models)
- [Limitations](#limitations)

## Roles

| Role | Who runs it | What for |
|---|---|---|
| `scout` | `forge:scout` (Read, Grep, Glob) | Find and read code, return a summary with `path:line` |
| `mechanic` | `forge:implementer` | An edit from precise instructions |
| `implementer` | `forge:implementer` (Read, Grep, Glob, Edit, Write, Bash) | A plan task |
| `senior` | `forge:implementer` | A task that can't be fully specified or where a mistake is expensive; the first retry after an implementer failure |
| `architect` | the main session (`agent=main`) | Spec and plan; the table row is for reference |
| `reviewer` | `forge:reviewer` (Read, Grep, Glob, Bash) | Diff review |
| `debugger` | `forge:debugger` (all tools) | Escalation after repeated failures |

## Models by mode

| Role | eco | normal | max |
|---|---|---|---|
| scout | haiku / low | haiku / low | sonnet / medium |
| mechanic | sonnet / low | sonnet / medium | sonnet / high |
| implementer | sonnet / medium | sonnet / high | opus / high |
| senior | sonnet / high | opus / high | opus / xhigh |
| architect | sonnet / high | opus / high | opus / xhigh |
| reviewer | sonnet / high | opus / high | fable / high |
| debugger | opus / high | fable / high | fable / high |

Strength is compared by model first (`haiku` < `sonnet` < `opus` < `fable`), then by effort (`low` < `medium` < `high` < `xhigh` < `max`). Switch the mode with [`/forge:mode`](skills.md#forgemode) or [`forge mode`](cli.md#commands); the default comes from the profile field [`mode`](profile.md#profile-fields).

## How skills dispatch a role

A skill runs [`forge route <role>`](cli.md#commands) and gets `role=… mode=… agent=… model=… effort=…`, then calls the agent from `agent=` with that `model` and `effort`; with `agent=main` the session does the work itself. That is why `/forge:mode eco` changes the models of the next calls without editing agent files. `model` and `effort` in the agents' frontmatter equal the `normal` row and are only a fallback for when an agent is called without them. `mechanic` and `senior` have no file of their own: without `forge route` they get the implementer values — `sonnet/high`, so senior would end up weaker than the table says.

## Retry ladder

Used by [`forge:execute`](skills.md#forgeexecute):

| Failed role | First retry, with the failure log | Second failure |
|---|---|---|
| `mechanic` | `implementer` | `debugger` with both logs |
| `implementer` | `senior` | `debugger` |
| `senior` | `senior` | `debugger` |
| any other (for example, `scout`) | the same role | `debugger` |

If `debugger` doesn't manage either, the skill stops and tells the user what is blocked. Separately, the Stop hook suggests `debugger` on the [second verification failure in a row](hooks.md#failure-streak).

## Invariants

`checkTable` in `lib/route.mjs`, for every mode:

- every role has a `model/effort` value with a known model and effort; there are no unknown roles;
- reviewer is not weaker than implementer; senior is not weaker than implementer; reviewer is not weaker than senior; debugger is not weaker than senior;
- `eco` has no `fable`.

The tests additionally require that in the built-in table senior is strictly stronger than implementer, the agents' frontmatter matches the `normal` row, scout has no Edit, Write and Bash, and reviewer has no Edit and Write.

## Routing overrides

The profile's [`routing`](profile.md#profile-fields) is laid over the built-in table by mode and role, and the result is checked by the same invariants. Any error — and the whole `routing` block is ignored in every mode, and the built-in table applies. This is reported by [session start](hooks.md#session-start-context) (as a count), `forge doctor` (lines `✗ routing: …`), `forge mode` (the line `! routing overrides from the profile were ignored: …` on stdout and `forge route` (on stderr). An override may make senior equal to implementer — then the first retry simply repeats the same model.

## Using other models

forge never names a concrete model. The table, [`forge route`](#how-skills-dispatch-a-role) and the agents' frontmatter use only the aliases `haiku`, `sonnet`, `opus` and `fable`, and the skills pass the alias to the subagent as is (the Agent tool's `model` parameter takes an alias, not a full model ID). Claude Code resolves each alias to a real model, and you choose which one — see [Model configuration](https://code.claude.com/docs/en/model-config) in the Claude Code docs.

### Mapping aliases to models

| Alias | Environment variable |
|---|---|
| `haiku` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| `sonnet` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `opus` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `fable` | `ANTHROPIC_DEFAULT_FABLE_MODEL` |

Each value is a full model name, or the equivalent identifier for your provider. Set them in the shell that starts Claude Code or in the `env` block of a settings file:

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<fast model>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<everyday model>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<strong model>",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "<strongest model>"
  }
}
```

The same mapping works:

- through an LLM gateway set with `ANTHROPIC_BASE_URL`: that variable changes where requests go, the four above choose which models the gateway is asked for (see [LLM gateways](https://code.claude.com/docs/en/llm-gateway); Anthropic doesn't support routing Claude Code to non-Claude models through a gateway);
- on Amazon Bedrock, Google Cloud's Agent Platform (Vertex AI) and Microsoft Foundry: the values are the provider's identifiers (an inference profile ARN, a version name, a deployment name). Claude Code's docs recommend pinning them there in any case.

### What doesn't depend on the model

[Hooks](hooks.md), [guards](guards.md), lint and verification, the end-of-turn reminders, the [profile](profile.md) and the [`forge` CLI](cli.md) are Node and shell code: they behave the same whatever model runs the session or the subagents. [Skills](skills.md) are instructions: any model can follow them, but how well it plans, reviews or keeps to the steps depends on the model.

### Caveats

- **Keep the alias order.** Strength is compared by alias (`haiku` < `sonnet` < `opus` < `fable`), not by the models behind them. The [invariants](#invariants) — reviewer not weaker than implementer, debugger not weaker than senior and the rest — mean something only if your mapping keeps that order: a stronger model behind a later alias.
- **Effort needs support in the model.** Claude Code enables effort levels by recognising the model ID. For an ID it doesn't recognise (a Bedrock ARN, a Foundry deployment name) effort stays off, and the role's `effort` is not applied, until you declare support with `ANTHROPIC_DEFAULT_<ALIAS>_MODEL_SUPPORTED_CAPABILITIES`, for example `effort,xhigh_effort,max_effort` (`xhigh` and `max` are separate capabilities). These capability variables take effect on Bedrock, Agent Platform and Foundry.
- **`CLAUDE_CODE_SUBAGENT_MODEL` alone doesn't change the roles**: it is the model for subagents that get no model another way, and forge always passes one. With `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` as well, every subagent runs on that one model — the per-call model and the agents' `model` are ignored — and modes and roles no longer choose models.
- **`CLAUDE_CODE_EFFORT_LEVEL`** takes precedence over the per-call effort and the agents' `effort`: with it set, every role runs at that level.
- **A family alias follows the main session.** When the main session runs on a model of the same family, a subagent with that alias runs on the main session's version: with the main session on a specific Opus version, the `opus` roles run on it too.

## Limitations

- That a skill calls a role through `forge route` with the right `model` and `effort` is ensured by the model, not by mechanics ([How skills dispatch a role](#how-skills-dispatch-a-role)).
