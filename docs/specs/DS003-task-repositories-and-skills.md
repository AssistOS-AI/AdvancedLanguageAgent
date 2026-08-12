---
id: DS003
title: Task repositories and A-Skills
status: active
owner: ALA maintainers
summary: Defines the extension boundary for independently versioned task families.
---

## Introduction

A task repository packages one coherent class of language work, such as translation, reference verification, CNL transformation, SOP Lang planning, scientific writing, or web research. Its A-Skills define task methodology.

## Core Content

Each repository must describe covered requests, selection evidence, expected inputs and outputs, available A-Skills, constraints, verification procedures, and generic ALA capabilities that may be requested. This semantic description participates in automatic routing.

An A-Skill must delegate model execution, agent execution, research access, and temporary workspace creation to ALA. ALA must not hard-code task-specific methodology in its core. Repositories must be independently configurable and versionable.

## Decisions & Questions

### Question #1: What descriptor format will repositories use?

Response: Discovery follows existing AchillesAgentLib skill conventions wherever practical. The repository manifest and descriptor schema are distribution-defined extension points.

### Question #2: How are incompatible skills isolated?

Options: Resolve repository isolation and dependency loading during implementation; no cross-repository execution guarantee is defined yet.

## Conclusion

Task repositories define what ALA knows how to do; ALA defines the generic execution substrate.
