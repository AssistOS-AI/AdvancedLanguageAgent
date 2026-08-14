---
title: DS006-workspaces-sessions-and-feedback
summary: Defines isolated multi-stage work, interactive correction, verification, and bounded escalation.
---

## Introduction

Some [A-Skills](wiki.html#definition-a-skill) require several stages, retained conversational context, or independent verification. [ALA](index.html) provides those generic facilities without taking ownership of the caller's software repository.

## Core Content

An A-Skill may request an isolated temporary [task workspace](wiki.html#definition-task-workspace). The workspace may hold explicit input material, retrieved sources, intermediate outputs, verification results, and final artifacts. It must not become an implicit copy of the caller's repository or a general persistent project directory.

Running `ala` without an instruction in a terminal or supplying `--interactive` must start an interactive session. A [MainAgent](wiki.html#definition-main-agent)-selected session must retain its [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) conversation, while a session using `--skill` must retain the selected A-Skill and include the previous result with each corrective instruction. `:quit` and `:exit` must close the session, and interruption must cancel the active AchillesAgentLib session.

Single-shot input must accept ordered text, UTF-8 file, HTTP(S), and standard-input payloads. Each file or URL response must be limited to 10 MiB, the combined payload must be limited to 32 MiB, and URL retrieval must stop after 30 seconds. Without a positional instruction in a non-interactive pipeline, standard input must supply the instruction; with a positional instruction, `--stdin` must add standard input as payload.

Interactive correction must preserve the task method unless the caller explicitly selects another task. Verification failure may cause ALA to move from a fast model to a stronger model or from direct execution to bounded [agentic execution](wiki.html#definition-agentic-execution).

Retries must have a finite configured limit. Workspace cleanup, retention, and sensitive-data handling must follow a documented deployment policy. Until that policy selects persistence guarantees, implementations must keep workspace scope isolated to one request and must not promise artifact retention.

[Task repositories](wiki.html#definition-task-repository) may include instructions intended for coding agents. Those instructions must define task methodology, required checks, and acceptance conditions. The coding agent supplies general planning and execution; the A-Skill continues to own domain procedure.

## Conclusion

ALA supports complex work through isolated task material, retained feedback context, verification, and finite escalation without assuming ownership of caller repositories.
