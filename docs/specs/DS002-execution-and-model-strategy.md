---
title: DS002-execution-and-model-strategy
summary: Defines generic execution capabilities, capability-based model resolution, and authenticated agent boundaries.
---

## Introduction

[ALA](index.html) resolves the requirements of general requests and [A-Skills](wiki.html#definition-a-skill) against configured models, agents, research facilities, and workspace support. A [task repository](wiki.html#definition-task-repository) requests capabilities for its specialized methods and must not bind those methods to one provider.

## Core Content

ALA must provide seven [generic execution capabilities](wiki.html#definition-generic-execution-capability): direct LLM execution, fast LLM execution, deep LLM execution, coding-agent execution, multi-step [agentic execution](wiki.html#definition-agentic-execution), web and research access, and temporary [task workspace](wiki.html#definition-task-workspace) creation. These capabilities describe how work runs; they must not embed translation, bibliography checking, controlled-language conversion, planning, or other domain methods.

All direct model work must pass through [AchillesAgentLib's](wiki.html#definition-achilles-agent-lib) [LLMAgent](wiki.html#definition-llm-agent) and runtime configuration. ALA must reuse compatible model tags and configured defaults. The generic model tiers are fast for inexpensive low-latency work, standard for ordinary language tasks, and premium or deep for quality-sensitive reasoning. Planning, coding, research, and long-context tags may add eligibility requirements.

Quality is a mandatory eligibility constraint. ALA may optimize latency and cost only among executors capable of meeting the selected A-Skill's requirements. Straightforward tasks should use direct model execution. Multi-step synthesis, iterative validation, complex research, and long transformations may use agentic execution or an authenticated coding-agent CLI.

ALA may invoke Codex, OpenCode, equivalent supported CLIs, or [Ploinky](wiki.html#definition-ploinky) agents when their advertised capabilities match the task. ALA must use supported invocation interfaces and must not extract, copy, or reuse credentials. A subscription-backed agent may satisfy a task when direct provider API keys are unavailable.

Provider names, model identifiers, and mappings from tags to concrete executors are runtime configuration. Manual overrides must be possible without changing an A-Skill. Escalation may occur after a bounded failed attempt when the A-Skill's quality checks justify it; the scoring policy and numeric bounds must be configured and must never permit unlimited retries.

## Conclusion

ALA selects execution backends by capability and required quality while preserving portable A-Skills and secure use of authenticated agents.
