---
id: DS004
title: Routing and execution flow
status: active
owner: ALA maintainers
summary: Defines explicit selection, Achilles fallback, symbolic routing, and execution separation.
---

## Introduction

ALA separates the decision about what the caller requests from the decision about how to execute it.

## Core Content

The normative flow is instruction to task or A-Skill selection, then execution requirements, then a generic ALA capability, then a model or agent. Explicit task or A-Skill selection must take precedence over automatic detection.

The default automatic path must remain compatible with AchillesAgentLib/MainAgent behavior. Experimental symbolic routing may inspect only the instruction and must support `DETERMINISTIC`, `HIGH`, `AMBIGUOUS`, and `UNKNOWN` states. Deterministic and sufficiently strong high-confidence matches may execute directly. Ambiguous and unknown results must fall back to the normal Achilles selection path.

## Decisions & Questions

### Question #1: What makes a HIGH match sufficiently strong?

Response: The confidence threshold and evidence aggregation are evaluation-configured parameters. Symbolic mode remains optional and must preserve fallback safety when evidence does not meet those parameters.

### Question #2: Can symbolic routing inspect payload data?

Response: No. It operates over the instruction only; payload inspection cannot increase symbolic confidence.

## Conclusion

Symbolic routing is an optional latency optimization with safe fallback, while MainAgent-compatible detection remains the baseline.
