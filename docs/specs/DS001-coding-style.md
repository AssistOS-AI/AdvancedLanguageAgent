---
title: DS001-coding-style
summary: Defines source layout, AchillesAgentLib conventions, file limits, documentation rules, and modular verification.
---

## Introduction

This specification is the canonical source for [ALA](index.html) coding style, source layout, file-size rules, and test organization. [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) is an authorized external dependency. Code owned by a [task repository](wiki.html#definition-task-repository) must remain portable with its task skill definitions.

## Core Content

ALA runtime code must use ECMAScript modules unless an affected specification states a justified exception. Production runtime, tests, configuration, and persistent data should use clear `src/`, `tests/`, and `data/` boundaries. Generic runtime code must remain separate from installed task repositories and their skill-local code.

Modules should have one responsibility, descriptive names, explicit entry points, and documented input, output, diagnostic, and failure behavior. Standard output must remain reserved for requested results. Modules should remain below 500 lines; files above 800 lines require decomposition. Code should normally keep lines within 120 characters, and code lines longer than 300 characters require review. Documentation prose blocks must remain unwrapped in HTML and Markdown source even when they exceed those code-oriented line-length thresholds. The repository-level `fileSizesCheck.sh` is the canonical mechanical check.

AchillesAgentLib must be declared in `package.json` under its package identity `ploinky-agent-lib` and installed from `git+https://github.com/AssistOS-AI/AchillesAgentLib.git#master`; the lockfile must record the resolved commit. All LLM interactions must use AchillesAgentLib's [LLMAgent](wiki.html#definition-llm-agent). Runtime configuration must combine environment-derived defaults with explicit manual overrides, and manual values must take precedence. Dependency resolution must permit an explicit AchillesAgentLib path, parent-directory resolution, and package resolution without hard-coding a workstation path.

AchillesAgentLib skill discovery must be limited to ALA-owned runtime skills such as the internal `coding-agent` Code Skill. Task-repository discovery must be implemented separately, must scan only files named `SKILL.md`, and must never reinterpret `cskill.md`, `oskill.md`, `tskill.md`, or `dcgskill.md` as task-skill descriptors. Anthropic task-skill execution must cross the internal coding-agent bridge and must not call an imported repository module as an AchillesAgentLib skill. An interactive task-repository refresh must preserve the active MainAgent, its AchillesAgentLib discovery registry, the coding-agent service, workspace files, selected backend, and native continuation while replacing only the separate Anthropic catalog, symbolic router metadata, and strict read-only task-skill mount set for the next coding-agent process.

Routing-sensitive work must apply relevant metadata tags for documentation, specification, orchestration, bootstrap, and testing. Model selection must follow DS002 rather than embedding provider-specific model names throughout task code.

Tests must be modular and grouped by concern. CLI input handling, output separation, task selection, symbolic abstention, executor selection, workspace lifecycle, configuration precedence, and retry bounds require independent tests. Tests must use deterministic fakes or contract fixtures and must not require real credentials.

Coding-agent process adapters must use argument-array child-process invocation without a shell, pass every execution and native model-catalog process through the common Bubblewrap launcher, preserve only explicitly allowed non-filesystem values needed by agent-owned authentication, parse only the supported output protocol of their backend, stream supported visible events, and return a normalized final response. The launcher must use an already installed backend runtime through a read-only bind rather than copying or reinstalling it, clear the inherited environment, replace home and XDG paths with sandbox paths, and expose only backend-specific authentication/state sources as controlled read-write mounts. Adapter tests must use fake executables or protocol fixtures and must not invoke installed subscriptions. Sandbox tests must independently verify runtime launch, workspace write access, strict task-skill and folder read-only access, explicitly authorized folder writes, hidden unmounted paths, environment filtering, and fail-closed startup.

Persistent documentation, specifications, and comments must be written in English. A source change that alters behavior, interfaces, architecture, workflows, or constraints must update both explanatory HTML documentation and affected DS files. The overview must remain the introduction and definition for ALA, while the wiki must contain specialized terminology without an ALA entry. Documentation should link the first useful occurrence of a specialized term to its wiki entry, must not self-link a term inside its own definition, and must not repeat terminology links without additional navigational value.

The runtime supports Node.js 20 or newer and uses the built-in Node.js test runner. No formatter or linter contract is imposed beyond the module, file-size, line-length, and documentation rules in this specification.

## Conclusion

ALA code must remain modular, portable, testable without credentials, and aligned with AchillesAgentLib configuration and LLMAgent conventions.
