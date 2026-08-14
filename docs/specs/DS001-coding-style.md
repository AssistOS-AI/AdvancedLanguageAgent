---
title: DS001-coding-style
summary: Defines source layout, AchillesAgentLib conventions, file limits, documentation rules, and modular verification.
---

## Introduction

This specification is the canonical source for ALA coding style, source layout, file-size rules, and test organization. AchillesAgentLib is an authorized external dependency. Code owned by a task repository must remain portable with its A-Skill.

## Core Content

ALA runtime code must use ECMAScript modules unless an affected specification states a justified exception. Production runtime, tests, configuration, and persistent data should use clear `src/`, `tests/`, and `data/` boundaries. Generic runtime code must remain separate from installed task repositories and their skill-local code.

Modules should have one responsibility, descriptive names, explicit entry points, and documented input, output, diagnostic, and failure behavior. Standard output must remain reserved for requested results. Modules should remain below 500 lines; files above 800 lines require decomposition. Code should normally keep lines within 120 characters, and code lines longer than 300 characters require review. Documentation prose blocks must remain unwrapped in HTML and Markdown source even when they exceed those code-oriented line-length thresholds. The repository-level `fileSizesCheck.sh` is the canonical mechanical check.

All LLM interactions must use AchillesAgentLib's `LLMAgent`. Runtime configuration must combine environment-derived defaults with explicit manual overrides, and manual values must take precedence. Dependency resolution must permit an explicit AchillesAgentLib path, parent-directory resolution, and package resolution without hard-coding a workstation path.

Routing-sensitive work must apply relevant metadata tags for documentation, specification, orchestration, bootstrap, and testing. Model selection must follow DS002 rather than embedding provider-specific model names throughout task code.

Tests must be modular and grouped by concern. CLI input handling, output separation, task selection, symbolic abstention, executor selection, workspace lifecycle, configuration precedence, and retry bounds require independent tests. Tests must use deterministic fakes or contract fixtures and must not require real credentials.

Persistent documentation, specifications, and comments must be written in English. A source change that alters behavior, interfaces, architecture, workflows, or constraints must update both explanatory HTML documentation and affected DS files.

Concrete formatter, linter, runtime-version, and package-manifest choices remain distribution boundaries. They must be documented before a distribution presents repository commands that depend on them.

## Conclusion

ALA code must remain modular, portable, testable without credentials, and aligned with AchillesAgentLib configuration and `LLMAgent` conventions.
