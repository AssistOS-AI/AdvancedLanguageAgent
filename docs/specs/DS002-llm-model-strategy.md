---
id: DS002
title: LLM and agent model strategy
status: active
owner: ALA maintainers
summary: Defines capability-based model resolution and authenticated agent use.
---

## Introduction

Advanced Language Agent (ALA) uses AchillesAgentLib, a JavaScript library for
discovering and running reusable agent skills. An A-Skill is a reusable
AchillesAgentLib skill containing the instructions and optional code for one kind
of task. ALA must choose a model or agent capable of
running the selected A-Skill adequately. It must reuse AchillesAgentLib semantic
model tags instead of creating a separate provider catalogue.

## Core Content

An A-Skill may request a fast large language model (LLM), deep reasoning, long context, web research,
direct LLM execution, coding-agent execution, or agentic execution. ALA must resolve
these requirements against configured models and available agents. Direct LLM calls
should serve straightforward work; stronger models or coding agents may serve
complex planning, research, transformation, or verification.

Authenticated command-line interfaces (CLIs) such as Codex and OpenCode may be
invoked through their supported commands when direct API keys are absent. ALA must
not extract, inspect, or reuse their credentials. A Ploinky agent is a remotely
invokable agent registered with the Ploinky router; ALA may select one when its
advertised operations match the task requirements.

## Decisions & Questions

### Question #1: Which tags and defaults are guaranteed?

Response: Existing AchillesAgentLib tags and configured defaults are reused where available. Distribution configuration supplies any ALA-specific default map.

### Question #2: How is quality adequacy measured?

Options: Capability thresholds may be shared by semantic model tag or configured per
deployment. Either choice must be evaluated against representative tasks before it
can authorize direct execution or escalation.

## Conclusion

A-Skills request execution requirements such as speed, reasoning strength, context
length, research access, or coding-agent use; ALA maps those requirements to
configured providers.
