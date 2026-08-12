---
id: DS001
title: Coding style and test organization
status: active
owner: ALA maintainers
summary: Defines source layout, coding conventions, documentation rules, and modular verification for ALA.
---

## Introduction

This specification establishes the source structure and coding rules for Advanced
Language Agent (ALA). AchillesAgentLib is the skill-based agent library used by ALA.
An A-Skill is a reusable AchillesAgentLib skill supplied by a task repository; any
examples or executable resources belonging to that skill must remain portable with
the repository that supplies it.

## Core Content

The implementation must use ECMAScript modules (ESM) unless a later specification
records a justified exception. Generic runtime code must stay separate from
task-repository content, routing metadata, and tests. Example code belonging to an
A-Skill must remain inside that skill or task repository; the host must not grow a
copied shared `src/` tree.

Modules should have one clear responsibility, use descriptive names, and expose stable boundaries through explicit entry modules. Public interfaces must document input, output, diagnostics, and failure behavior. Standard output must remain reserved for requested results.

Tests must be modular and colocated by concern or grouped under a dedicated `tests/`
tree. Routing, executor selection, workspace lifecycle, retry bounds, CLI parsing,
and output separation require independent tests. Tests must not require real
provider credentials; external integrations need deterministic fakes or contract
fixtures.

Persistent documentation and comments must be written in English. The repository-level `fileSizesCheck.sh` is the canonical size and line-length check and must run before broad documentation or source changes are submitted.

## Decisions & Questions

### Question #1: Which runtime and formatter are mandatory?

Response: The deployment selects the supported runtime, formatter, linter, and package manifest. Their concrete values belong to the distribution configuration and must not change the source-layout contract.

### Question #2: Where should production modules live?

Options: The package may place production modules under a dedicated `src/` directory
or expose a small set of top-level entry modules. A selected layout must keep ALA
runtime modules separate from independently installed task repositories.

## Conclusion

This specification is the canonical source for ALA coding style, source layout, and
test organization.
