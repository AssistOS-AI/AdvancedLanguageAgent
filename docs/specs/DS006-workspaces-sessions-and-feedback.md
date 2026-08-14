---
title: DS006-workspaces-sessions-and-feedback
summary: Defines isolated multi-stage work, interactive correction, verification, and bounded escalation.
---

## Introduction

Some A-Skills require several stages, retained conversational context, or independent verification. ALA provides those generic facilities without taking ownership of the caller's software repository.

## Core Content

An A-Skill may request an isolated temporary task workspace. The workspace may hold explicit input material, retrieved sources, intermediate outputs, verification results, and final artifacts. It must not become an implicit copy of the caller's repository or a general persistent project directory.

Interactive sessions must retain the selected task and previous result so that corrective feedback can become an additional constraint on the next attempt. A retry must preserve the task method unless the caller explicitly selects another task. Verification failure may cause ALA to move from a fast model to a stronger model or from direct execution to bounded agentic execution.

Retries must have a finite configured limit. Workspace cleanup, retention, and sensitive-data handling must follow a documented deployment policy. Until that policy selects persistence guarantees, implementations must keep workspace scope isolated to one request and must not promise artifact retention.

Task repositories may include instructions intended for coding agents. Those instructions must define task methodology, required checks, and acceptance conditions. The coding agent supplies general planning and execution; the A-Skill continues to own domain procedure.

## Conclusion

ALA supports complex work through isolated task material, retained feedback context, verification, and finite escalation without assuming ownership of caller repositories.
