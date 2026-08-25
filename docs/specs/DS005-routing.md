---
title: DS005-routing
summary: Defines explicit Anthropic skill selection, coding-agent catalog selection, symbolic abstention, and general-request fallback.
---

## Introduction

[ALA](index.html) separates optional task routing from [execution routing](wiki.html#definition-execution-routing). A general request may proceed directly to execution requirements and a configured model or agent. When task skills are available, the path may first select a task method and then resolve its execution requirements.

## Core Content

Explicit task skill selection through `--skill` must take precedence, resolve the matching Anthropic `SKILL.md` descriptor without automatic intent classification, and execute it through the first available [coding agent](wiki.html#definition-coding-agent). An unknown explicit task skill must produce repository exit code `4`; an unavailable coding agent must produce execution exit code `5`. Without `--skill`, ALA must ask a coding agent to select from a populated [skill catalog](wiki.html#definition-skill-catalog). An empty catalog or unavailable coding agent must leave general model-backed execution with AchillesAgentLib [MainAgent](wiki.html#definition-main-agent).

Explicit coding-agent selection through `--agent` must bypass task intent classification and execute ALA's generic coding-agent Code Skill. `auto`, `codex`, `opencode`, and `pi` are the supported values. `--agent` and `--skill` must be rejected together as conflicting explicit routes. Explicit agent selection must also reject `--model`, `--tag`, `--reasoning-effort`, and `--model-config` because these options configure ALA's LLMAgent rather than the selected external agent. One or more active folder mounts must also force the coding-agent route even without `--agent` or a populated task catalog; an unavailable backend must then produce execution exit code `5`. Removing the last interactive folder must restore ordinary routing for later prompts.

Experimental [symbolic routing](wiki.html#definition-symbolic-routing) must be disabled by default and enabled for an interactive session only through `/symbolic detection on`; `/symbolic detection off` must disable it again. When enabled, it must inspect only the instruction and must not use payload contents to increase confidence. It may extract actions, objects, targets, modifiers, structural markers, and explicit relationships between operations. [Task repositories](wiki.html#definition-task-repository) may contribute an `## Symbolic Routing` descriptor section with comma-separated `actions`, `objects`, `targets`, `modifiers`, `phrases`, `required`, and `conflicts` values.

The symbolic result must be `DETERMINISTIC`, `HIGH`, `AMBIGUOUS`, or `UNKNOWN`. `DETERMINISTIC` and sufficiently strong `HIGH` results may select one descriptor before coding-agent execution. `AMBIGUOUS` and `UNKNOWN` results must use [abstention](wiki.html#definition-abstention) and let the coding agent inspect the complete catalog. False confident selection must be treated as more harmful than abstention.

After task selection, execution routing must choose an available coding agent without changing the task skill's methodology. Unsupported requests must not be forced into an unrelated skill. Usage and configuration failures use exit code `2`, input failures use `3`, repository and task-skill discovery failures use `4`, coding-agent and other execution failures use `5`, and interruption uses `130`; every diagnostic must remain on standard error.

The current implementation uses a conservative internal score and score-margin threshold for `HIGH`; it exposes no separate threshold setting. The router must preserve fallback whenever the evidence does not justify a safe direct decision.

## Conclusion

ALA preserves routing correctness by supporting MainAgent general execution with an empty or unusable catalog, honoring explicit Anthropic skill selection, using coding-agent catalog selection when skills are available, and allowing symbolic routing only with safe abstention.
