---
id: DS002
title: LLM and agent model strategy
status: active
owner: ALA maintainers
summary: Defines capability-based model resolution and authenticated agent use.
---

## Introduction

ALA must choose an executor that can complete the selected A-Skill adequately. It must preserve AchillesAgentLib-compatible semantic model tags instead of creating a second provider catalogue.

## Core Content

An A-Skill may request a fast LLM, deep reasoning, long context, web research, direct LLM execution, coding-agent execution, or agentic execution. ALA must resolve these requirements against configured models and available agents. Direct LLM calls should serve straightforward work; stronger models or coding agents may serve complex planning, research, transformation, or verification.

Authenticated CLIs such as Codex and OpenCode may be invoked through supported interfaces when direct API keys are absent. ALA must not extract, inspect, or reuse their credentials. Ploinky agents may be selected when advertised capabilities match.

## Decisions & Questions

### Question #1: Which tags and defaults are guaranteed?

Response: Existing AchillesAgentLib tags and configured defaults are reused where available. Distribution configuration supplies any ALA-specific default map.

### Question #2: How is quality adequacy measured?

Options: Define executor capability thresholds and escalation signals with the first runtime and evaluation corpus; no provider-specific threshold is normative yet.

## Conclusion

Capability requests, not concrete providers, are the A-Skill-to-ALA contract.
