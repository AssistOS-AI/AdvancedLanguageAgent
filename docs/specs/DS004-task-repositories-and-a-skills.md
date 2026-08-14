---
title: DS004-task-repositories-and-a-skills
summary: Defines independently versioned task families and their AchillesAgentLib A-Skill contract.
---

## Introduction

A task repository packages one coherent family of work, such as translation, scientific-reference verification, controlled-language transformation, SOP Lang planning, scientific writing, or web research. Task repositories evolve independently from ALA and from one another.

## Core Content

An A-Skill is a reusable AchillesAgentLib skill inside a task repository. It uses the conventions of its AchillesAgentLib skill family and supplies task instructions, constraints, validation rules, and optional code. ALA must not translate it into a proprietary skill representation.

Each task repository must describe the request class it covers, positive and conflicting selection evidence, expected inputs and outputs, available A-Skills, constraints, verification procedures, and generic ALA capabilities its skills may request. The description must participate in routing and must not serve only as human documentation.

An A-Skill must own domain methodology and acceptance conditions while delegating model calls, agent execution, research access, and temporary workspace creation to ALA. It may be implemented as an AchillesAgentLib Code Skill (`cskill.md`), Orchestration Skill (`oskill.md`), DBTable Skill (`tskill.md`), Dynamic Code Generation Skill (`dcgskill.md`), or another runtime-compatible family.

ALA must discover configured repositories through AchillesAgentLib conventions where practical. Repositories must remain independently installable, configurable, and versionable. Imported A-Skill documentation and specifications must remain in the owning task repository and must not be copied into ALA's `docs/` tree.

The stable semantic requirements above do not select concrete manifest filenames or serialization. Automatic routing must not depend on undocumented metadata fields until an implementation contract defines them.

## Conclusion

Task repositories define what ALA knows how to do, and AchillesAgentLib A-Skills define each task method while ALA provides generic execution services.
