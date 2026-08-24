---
title: DS007-integration-and-evaluation
summary: Defines standalone and Ploinky operation, independent configuration, and Anthropic skill-routing evaluation.
---

## Introduction

[ALA](index.html) must operate inside and outside [Ploinky](wiki.html#definition-ploinky) while preserving the same CLI task contract. Routing behavior must be evaluated across explicit, default, and symbolic-first selection paths.

## Core Content

User-level configuration must default to `~/.config/ala/config.json`, while `ALA_CONFIG_PATH` must select another file and `--config` must have the highest priority for one command. [Task repositories](wiki.html#definition-task-repository) must remain independently manageable through the `ala repo` commands. ALA must reuse [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) model configuration and tags when available. CLI values must override environment values, which must override AchillesAgentLib defaults. The supported environment interfaces are `ALA_CONFIG_PATH`, `ALA_TASK_REPOSITORIES`, `ALA_MODEL`, `ALA_TAGS`, `ALA_REASONING_EFFORT`, `ACHILLES_AGENT_LIB_PATH`, `LLM_MODELS_CONFIG_PATH`, `CODEX_BIN`, `OPENCODE_BIN`, `PI_BIN`, and `ALA_CODING_AGENT_PRIORITY`.

The version-1 JSON configuration may contain `codingAgents.priority` as an ordered array of unique supported backend names and `codingAgents.models` as an object mapping `codex`, `opencode`, or `pi` to a non-empty native model identifier. Missing backend names must be appended in the default order so a partial preference remains valid. Agent credentials and agent-native provider configuration must not be persisted by ALA; only the explicit per-backend model selection may be stored.

As a Ploinky agent, ALA may expose the same operations through Ploinky CLI, router, and [WebChat](wiki.html#definition-webchat) integrations. Anthropic task-skill execution must continue to use a detected Codex, OpenCode, or Pi coding agent. Standalone ALA operation must not depend on Ploinky.

[Routing evaluation](wiki.html#definition-routing-evaluation) must compare explicit Anthropic skill selection, coding-agent catalog selection, and [symbolic routing](wiki.html#definition-symbolic-routing) before catalog fallback. The same corpus must include canonical instructions, paraphrases, multilingual requests, spelling errors, ambiguous requests, multi-step tasks, missing parameters, and unsupported tasks.

Symbolic evaluation must report correct direct routing, incorrect direct routing, [abstention](wiki.html#definition-abstention) rate, fallback rate, and final correctness after fallback. Evaluation must assign a greater cost to false confident selection than to abstention because a false direct route bypasses the safe default selector with the wrong method.

Remote-agent protocols, [task-workspace](wiki.html#definition-task-workspace) retention values, retry counts, and symbolic thresholds remain specialized deployment contracts. The standalone distribution must preserve portable repository paths, bounded input handling, secure credential handling, and result-stream separation.

## Conclusion

ALA integrations must preserve a common task interface and must measure routing in a way that rewards correct direct selection and safe fallback.
