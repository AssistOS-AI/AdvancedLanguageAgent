---
id: DS003
title: Task repositories and A-Skills
status: active
owner: ALA maintainers
summary: Defines the extension boundary for independently versioned task families.
---

## Introduction

A task repository extends Advanced Language Agent (ALA) with one coherent class of
language work, such as translation,
reference verification, controlled-natural-language transformation, SOP Lang
planning, scientific writing, or web research. AchillesAgentLib is the JavaScript
library ALA uses to discover and run skills. An A-Skill is a reusable
AchillesAgentLib skill in a task repository. It packages task instructions and
optional code using a supported family: Code Skills run repository-provided modules,
Orchestration Skills coordinate multiple actions, DBTable Skills describe table
operations, and Dynamic Code Generation Skills produce code during execution.

## Core Content

Each repository must describe the requests it covers, the evidence used to select
it, expected inputs and outputs, available A-Skills, constraints, verification
procedures, and required ALA services. ALA must use this description during
automatic routing.

An A-Skill must delegate model calls, agent execution, research access, and temporary
workspace creation to ALA. ALA must not hard-code task-specific instructions or
validation procedures in its runtime. Task repositories must remain independently
configurable and versionable.

## Decisions & Questions

### Question #1: What descriptor format will repositories use?

Response: Discovery follows existing AchillesAgentLib skill conventions wherever practical. The repository manifest and descriptor schema are distribution-defined extension points.

### Question #2: How are incompatible skills isolated?

Options: A deployment may isolate every task repository in its own dependency scope
or allow repositories to share dependencies through the ALA installation. No
cross-repository execution guarantee applies until one isolation policy is selected.

## Conclusion

Task repositories define the work ALA can select; ALA supplies the shared services
used to execute that work.
