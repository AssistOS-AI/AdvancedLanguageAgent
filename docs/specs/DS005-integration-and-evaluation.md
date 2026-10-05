---
title: DS005-integration-and-evaluation
summary: Defines standalone and Ploinky operation, independent configuration, and the coding-agent mount contract.
---

## Introduction

[ALA](index.html) must operate inside and outside [Ploinky](wiki.html#definition-ploinky) while preserving the same CLI task contract. Integration must not reintroduce task-skill catalog management into the core runner.

## Core Content

User-level configuration must default to `$HOME/.ala/config.json`. `ALA_CONFIG_PATH` must select a root directory beneath which ALA uses `.ala/config.json`, while an explicit `--config <file>` must have the highest priority for one command. ALA must reuse [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) model configuration and tags when available. CLI values must override environment values, which must override AchillesAgentLib defaults. The supported environment interfaces are `ALA_CONFIG_PATH`, `ALA_MODEL`, `ALA_TAGS`, `ALA_REASONING_EFFORT`, `ACHILLES_AGENT_LIB_PATH`, `LLM_MODELS_CONFIG_PATH`, `CODEX_BIN`, `OPENCODE_BIN`, and `PI_BIN`.

The JSON configuration is an object with three optional fields: `codingAgent` names the default backend (`codex`, `opencode`, or `pi`), `models` maps a backend name to a non-empty native model identifier, and `efforts` maps a backend that has a configured model to a native effort name. ALA must reject any other field with "ALA configuration supports only codingAgent, models and efforts" and exit code `2`. The file has no version field, and ALA keeps no migration path or legacy reader, so a file in the former `version` and `codingAgents` layout fails until the user rewrites it. A missing file means `{ models: {}, efforts: {} }`. ALA must not persist agent credentials, agent-native provider configuration, or folder registrations.

As a Ploinky agent, ALA may expose the same operations through Ploinky CLI, router, and [WebChat](wiki.html#definition-webchat) integrations. ALA runs the detected Codex, OpenCode, or Pi coding agent against exactly the caller-provided `--cwd` and `--folder` mounts. Standalone ALA operation must not depend on Ploinky. An embedding application that shows conversation history must read ALA session transcripts through the `advanced-language-agent/transcript` package export defined in DS004 and may select their location with `ALA_SESSIONS`.

Remote-agent protocols, retained [task-workspace](wiki.html#definition-task-workspace) values, and retry counts remain specialized deployment contracts. The standalone distribution must preserve portable repository paths, bounded input handling, secure credential handling, and result-stream separation. Linux deployments that enable coding agents must provide a functioning `bwrap`; Ploinky and standalone launches must preserve the same fail-closed sandbox and explicit mount contract.

## Conclusion

ALA integrations must preserve a common task interface and the caller-owned mount contract without reintroducing task-skill catalog management.
