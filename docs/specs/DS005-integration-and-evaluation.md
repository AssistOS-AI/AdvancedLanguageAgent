---
title: DS005-integration-and-evaluation
summary: Defines standalone and Ploinky operation, independent configuration, and the coding-agent mount contract.
---

## Introduction

[ALA](index.html) must operate inside and outside [Ploinky](wiki.html#definition-ploinky) while preserving the same CLI task contract. Integration must not reintroduce task-skill catalog management into the core runner.

## Core Content

User-level configuration must default to `$HOME/.ala/config.json`. `ALA_CONFIG_PATH` must select a root directory beneath which ALA uses `.ala/config.json`, while an explicit `--config <file>` must have the highest priority for one command. ALA must reuse [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) model configuration and tags when available. CLI values must override environment values, which must override AchillesAgentLib defaults. The supported environment interfaces are `ALA_CONFIG_PATH`, `ALA_MODEL`, `ALA_TAGS`, `ALA_REASONING_EFFORT`, `ACHILLES_AGENT_LIB_PATH`, `LLM_MODELS_CONFIG_PATH`, `CODEX_BIN`, `OPENCODE_BIN`, `PI_BIN`, and `ALA_CODING_AGENT_PRIORITY`.

The version-1 JSON configuration may contain `codingAgents.priority` as an ordered array of unique supported backend names, `codingAgents.models` as an object mapping `codex`, `opencode`, or `pi` to a non-empty native model identifier, and `codingAgents.websearch` as a Boolean that defaults to `false` when omitted. Missing backend names must be appended in the default order so a partial preference remains valid. Legacy `taskRepositories` fields in existing files are ignored. Agent credentials, agent-native provider configuration, and folder registrations must not be persisted by ALA; only explicit per-backend model selections and the shared web-search Boolean may be stored. Bare `--websearch` or explicit `--websearch on|off` must take precedence for one process without modifying this file.

As a Ploinky agent, ALA may expose the same operations through Ploinky CLI, router, and [WebChat](wiki.html#definition-webchat) integrations. ALA runs the detected Codex, OpenCode, or Pi coding agent against exactly the caller-provided `--cwd` and `--folder` mounts. Standalone ALA operation must not depend on Ploinky.

Remote-agent protocols, retained [task-workspace](wiki.html#definition-task-workspace) values, and retry counts remain specialized deployment contracts. The standalone distribution must preserve portable repository paths, bounded input handling, secure credential handling, and result-stream separation. Linux deployments that enable coding agents must provide a functioning `bwrap`; Ploinky and standalone launches must preserve the same fail-closed sandbox and explicit mount contract.

## Conclusion

ALA integrations must preserve a common task interface and the caller-owned mount contract without reintroducing task-skill catalog management.
