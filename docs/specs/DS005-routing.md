---
id: DS005
title: Task and execution routing
status: active
owner: ALA maintainers
summary: Defines explicit selection, MainAgent-compatible detection, symbolic abstention, and separation of task and executor choices.
---

## Introduction

ALA separates task routing from execution routing. The complete path moves from an
instruction to task and A-Skill selection, then to execution requirements, a generic
ALA capability, and a configured model or agent.

## Core Content

Explicit task or A-Skill selection must take precedence and bypass automatic intent
classification. Without explicit selection, the default path must remain compatible
with AchillesAgentLib `MainAgent`, which coordinates discovered skill selection and
the matching execution subsystem.

Experimental symbolic routing may precede the default selector. It must inspect only
the instruction and must not use payload contents to increase confidence. It may
extract actions, objects, targets, modifiers, structural markers, and explicit
relationships between operations. Task repositories may contribute characteristic
phrases, required parameters, and conflicting evidence.

The symbolic result must be `DETERMINISTIC`, `HIGH`, `AMBIGUOUS`, or `UNKNOWN`.
`DETERMINISTIC` and sufficiently strong `HIGH` results may route directly.
`AMBIGUOUS` and `UNKNOWN` results must abstain and fall back to the MainAgent-
compatible selector. False confident selection must be treated as more harmful than
abstention.

After task selection, execution routing must map the A-Skill's requirements to an
eligible capability without changing its methodology. Unsupported requests must not
be forced into an unrelated skill. The exact failure diagnostic and exit code remain
distribution-owned, but the diagnostic must remain outside the result stream.

The numeric threshold for `HIGH` remains experimental configuration. A deployment
must evaluate it against false direct routing and must preserve fallback whenever
the evidence does not justify a safe direct decision.

## Conclusion

ALA preserves routing correctness by honoring explicit selection, using a
MainAgent-compatible default, and allowing symbolic acceleration only with safe
abstention.
