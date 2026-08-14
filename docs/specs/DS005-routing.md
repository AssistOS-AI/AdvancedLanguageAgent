---
title: DS005-routing
summary: Defines explicit selection, MainAgent-compatible detection, symbolic abstention, and separation of task and executor choices.
---

## Introduction

[ALA](index.html) separates optional task routing from [execution routing](wiki.html#definition-execution-routing). A general request may proceed directly to execution requirements and a configured model or agent. When [A-Skills](wiki.html#definition-a-skill) are available, the path may first select a task method and then resolve its execution requirements.

## Core Content

Explicit A-Skill selection through `--skill` must take precedence and call the matching [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) subsystem without automatic intent classification. Without `--skill`, ALA must call AchillesAgentLib [MainAgent](wiki.html#definition-main-agent). MainAgent must execute a general model-backed request when the aggregated [skill catalog](wiki.html#definition-skill-catalog) is empty and may coordinate skill selection when the catalog is populated. An unknown explicit A-Skill must produce repository exit code `4` on standard error.

Explicit [coding-agent](wiki.html#definition-coding-agent) selection through `--agent` must bypass task intent classification and execute ALA's generic coding-agent Code Skill. `auto`, `codex`, `opencode`, and `pi` are the supported values. `--agent` and `--skill` must be rejected together as conflicting explicit routes. Explicit agent selection must also reject `--model`, `--tag`, `--reasoning-effort`, and `--model-config` because these options configure ALA's LLMAgent rather than the selected external agent. Without either explicit route, MainAgent may select the generic coding-agent skill when it is registered alongside the optional task catalog.

Experimental [symbolic routing](wiki.html#definition-symbolic-routing) must be disabled by default and enabled for an interactive session only through `/symbolic detection on`; `/symbolic detection off` must disable it again. When enabled, it must inspect only the instruction and must not use payload contents to increase confidence. It may extract actions, objects, targets, modifiers, structural markers, and explicit relationships between operations. [Task repositories](wiki.html#definition-task-repository) may contribute an `## Symbolic Routing` descriptor section with comma-separated `actions`, `objects`, `targets`, `modifiers`, `phrases`, `required`, and `conflicts` values.

The symbolic result must be `DETERMINISTIC`, `HIGH`, `AMBIGUOUS`, or `UNKNOWN`. `DETERMINISTIC` and sufficiently strong `HIGH` results may route directly. `AMBIGUOUS` and `UNKNOWN` results must use [abstention](wiki.html#definition-abstention) and fall back to the MainAgent-compatible selector. False confident selection must be treated as more harmful than abstention.

After task selection, execution routing must map the A-Skill's requirements to an eligible capability without changing its methodology. Unsupported requests must not be forced into an unrelated skill. Usage and configuration failures use exit code `2`, input failures use `3`, repository and A-Skill failures use `4`, execution failures use `5`, and interruption uses `130`; every diagnostic must remain on standard error.

The current implementation uses a conservative internal score and score-margin threshold for `HIGH`; it exposes no separate threshold setting. The router must preserve fallback whenever the evidence does not justify a safe direct decision.

## Conclusion

ALA preserves routing correctness by supporting general execution with an empty catalog, honoring explicit skill selection, using a MainAgent-compatible default, and allowing symbolic routing only with safe abstention.
