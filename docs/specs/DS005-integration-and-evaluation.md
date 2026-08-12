---
id: DS005
title: Integration, workspaces, feedback, and evaluation
status: active
owner: ALA maintainers
summary: Defines deployment boundaries, temporary workspaces, bounded retries, and routing evaluation.
---

## Introduction

ALA must work as a standalone CLI and may also run as a Ploinky agent. Complex A-Skills need controlled intermediate state and feedback without taking ownership of a caller's repository.

## Core Content

Task repositories must be configurable independently from the ALA installation. Existing AchillesAgentLib model configuration and tags should be reused. ALA may expose its CLI through existing Ploinky CLI and WebChat mechanisms when deployed there.

An A-Skill may request an isolated temporary workspace containing explicit inputs, retrieved sources, intermediate outputs, verification results, and final artifacts. The workspace must not be treated as an implicit copy of the caller's software repository. Interactive sessions must preserve the current task and previous answer. Feedback becomes an additional constraint, retries remain bounded, and repeated quality failures may trigger model or execution escalation.

Evaluation must compare explicit selection, default MainAgent detection, and symbolic-first detection across canonical, paraphrased, multilingual, misspelled, ambiguous, multi-step, incomplete, and unsupported requests. It must report correct direct routing, incorrect direct routing, abstention, fallback, and final correctness after fallback. False confident routing is worse than abstention.

## Decisions & Questions

### Question #1: What are the CLI and configuration contracts?

Response: The distribution contract defines the executable name, option syntax, manifest, configuration file, environment variables, exit codes, and diagnostic schema. These deployment details are intentionally independent from the ALA task and routing contracts.

### Question #2: What retry limit and escalation policy apply?

Options: Select bounded limits and quality signals with the first implementation and evaluation fixtures; no unbounded retry behavior is permitted.

## Conclusion

Integration and evaluation must make ALA portable across provider environments while preserving output separation, bounded work, and measurable routing safety.
