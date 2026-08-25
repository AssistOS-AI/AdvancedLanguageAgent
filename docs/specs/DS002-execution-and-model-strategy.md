---
title: DS002-execution-and-model-strategy
summary: Defines LLMAgent general execution, coding-agent task-skill execution, backend selection, and authentication boundaries.
---

## Introduction

[ALA](index.html) executes general requests through configured models and executes Anthropic task skills through detected coding agents. A [task repository](wiki.html#definition-task-repository) defines portable methodology without declaring an AchillesAgentLib skill family.

## Core Content

ALA must provide seven [generic execution capabilities](wiki.html#definition-generic-execution-capability): direct LLM execution, fast LLM execution, deep LLM execution, coding-agent execution, multi-step [agentic execution](wiki.html#definition-agentic-execution), web and research access, and temporary [task workspace](wiki.html#definition-task-workspace) creation. These capabilities describe how work runs; they must not embed translation, bibliography checking, controlled-language conversion, planning, or other domain methods.

All direct model work must pass through [AchillesAgentLib's](wiki.html#definition-achilles-agent-lib) [LLMAgent](wiki.html#definition-llm-agent) and runtime configuration. ALA must reuse compatible model tags and configured defaults. The generic model tiers are fast for inexpensive low-latency work, standard for ordinary language tasks, and premium or deep for quality-sensitive reasoning. Planning, coding, research, and long-context tags may add eligibility requirements.

Quality is a mandatory eligibility constraint. Straightforward general tasks should use direct model execution. Every selected Anthropic task skill must use an authenticated coding-agent CLI, which may perform multi-step synthesis, validation, research, transformation, or tool use as directed by `SKILL.md`.

The standalone runtime must support Codex, OpenCode, and Pi through a generic [coding-agent](wiki.html#definition-coding-agent) Code Skill. Each process must detect the supported executables through `CODEX_BIN`, `OPENCODE_BIN`, and `PI_BIN`, then standard user installation locations and `PATH`. The skill must be registered only when at least one backend is executable. Automatic backend choice must follow `ALA_CODING_AGENT_PRIORITY` before the persistent `codingAgents.priority` array and must otherwise use Codex, OpenCode, then Pi.

ALA must use supported non-interactive and native continuation interfaces and must not extract, copy, or reuse credentials. ALA must query available models through a native adapter for each supported backend: Codex app-server `model/list`, `opencode models`, and `pi --list-models`. A backend-specific model persisted in `codingAgents.models` must be passed with the native model option on every invocation of that backend, including native continuation; when no value is configured, ALA must omit the option so the selected CLI uses its own default. Agent authentication and agent-native provider configuration remain owned by the selected CLI. A subscription-backed agent may satisfy a task when direct provider API keys are unavailable. Failure after a backend process starts must not cause automatic failover because the temporary workspace may already contain partial work.

Coding-agent web search must be controlled by one shared Boolean runtime value. It must default to disabled, accept bare `--websearch` as an invocation-only enable flag, accept `--websearch on|off` as an explicit invocation-only override, and accept interactive `/websearch on|off` as an immediately applied persistent update. ALA must translate enabled state to Codex native live search and OpenCode web-search and web-fetch permission with its Exa integration enabled. Disabled state must explicitly disable Codex search and deny OpenCode web-search and web-fetch tools. Pi has no ALA-managed web-search capability: ALA must not install or load a third-party extension and must leave Pi arguments and tools unchanged regardless of this setting. Agent and search-provider authentication, quotas, rate limits, and source-site policy remain outside ALA.

Provider names, model identifiers, and mappings from tags to concrete executors are runtime configuration for direct model work. Manual overrides must remain available without changing a task skill. Coding-agent authentication and model catalogs remain owned by the agent CLI, while ALA may persist only the user-selected backend model identifier and shared web-search Boolean. The direct-execution `--model`, `--tag`, `--reasoning-effort`, `--model-config`, and their environment-derived LLMAgent values must not be forwarded or reinterpreted as coding-agent configuration.

## Conclusion

ALA preserves portable Anthropic task skills by executing them through authenticated coding agents while keeping general model work inside configured AchillesAgentLib components.
