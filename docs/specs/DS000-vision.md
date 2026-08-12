---
id: DS000
title: ALA vision
status: active
owner: ALA maintainers
summary: Defines the purpose, boundary, and user-visible contract of Advanced Language Agent.
---

## Introduction

Advanced Language Agent (ALA) is a system-installed command-line interface for
language-oriented and documentation-oriented work. ALA uses AchillesAgentLib, a
JavaScript library for discovering and executing reusable agent skills. An A-Skill
is a reusable AchillesAgentLib skill supplied by a task repository. It packages the
instructions and optional code for one kind of work. Code Skills run modules,
Orchestration Skills coordinate multiple actions, DBTable Skills describe table
operations, and Dynamic Code Generation Skills produce code during execution.

## Core Content

ALA must provide one stable interface for interactive and single-shot requests. It
must accept instructions and optional inputs from arguments, standard input, URLs,
or files, and return the requested result through standard output or a file.
Diagnostics and routing information must remain separate from the result stream.

ALA must provide the services shared by language tasks: routing, large language
model (LLM) calls, agent execution, research access, temporary workspaces, and
bounded feedback retries. Task-specific instructions and validation rules must
remain in independently versioned task repositories and their A-Skills.

## Decisions & Questions

### Question #1: Which product boundary is normative?

Response: The normative product is the stable ALA CLI and the shared execution
services it exposes. Repository layout is not part of the user-facing contract.

### Question #2: What is the dependency boundary?

Response: ALA reuses AchillesAgentLib `MainAgent`, the coordinator responsible for
skill discovery and selection, together with compatible model configuration. The
ALA distribution defines how that dependency is packaged.

## Conclusion

ALA provides shared execution services and keeps task-specific instructions and
validation rules in A-Skills.
