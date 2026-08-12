---
id: DS004
title: Routing and execution flow
status: active
owner: ALA maintainers
summary: Defines explicit selection, Achilles fallback, symbolic routing, and execution separation.
---

## Introduction

Advanced Language Agent (ALA) uses AchillesAgentLib, a JavaScript library for
discovering and running reusable agent skills. An A-Skill is a reusable
AchillesAgentLib skill containing the instructions and optional code for one kind
of task. ALA separates selection of that task from
selection of the model, agent, research tool, or workspace that runs it.

## Core Content

The normative flow is instruction to A-Skill selection, then execution requirements,
then a configured model, agent, research tool, or workspace. Explicit task or
A-Skill selection must take precedence over automatic detection.

The default automatic path must use AchillesAgentLib's `MainAgent`, the coordinator
that compares the instruction with registered skills. Experimental symbolic routing may
inspect only the instruction and must
support `DETERMINISTIC`, `HIGH`, `AMBIGUOUS`, and `UNKNOWN` states. Deterministic
and sufficiently strong high-confidence matches may execute directly. Ambiguous and
unknown results must fall back to the normal Achilles selection path.

## Decisions & Questions

### Question #1: What makes a HIGH match sufficiently strong?

Response: The confidence threshold and evidence aggregation are evaluation-configured parameters. Symbolic mode remains optional and must preserve fallback safety when evidence does not meet those parameters.

### Question #2: Can symbolic routing inspect payload data?

Response: No. It operates over the instruction only; payload inspection cannot increase symbolic confidence.

## Conclusion

Symbolic routing is an optional latency optimization. MainAgent remains the baseline
and must receive every ambiguous or unknown symbolic result.
