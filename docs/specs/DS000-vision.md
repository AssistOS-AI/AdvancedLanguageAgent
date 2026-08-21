---
title: DS000-vision
summary: Defines the purpose, user-visible result, and product boundary of Advanced Language Agent.
---

## Introduction

[Advanced Language Agent (ALA)](index.html) is a system-installed command-line interface for language-oriented and documentation-oriented work. It gives human and agent callers one stable interface for reusable task methods without requiring them to integrate [AchillesAgentLib](wiki.html#definition-achilles-agent-lib), model providers, research tools, or coding agents directly.

## Core Content

ALA must support interactive and single-shot requests. A caller must be able to provide an instruction and optional input through command arguments, standard input, a URL, or a file. ALA must write the requested result to standard output or a file and must keep diagnostics and routing information separate from that result.

The distribution executable is `ala`. It must accept positional instructions, explicit payload-source options, explicit [task skill](wiki.html#definition-a-skill) selection through `--skill`, explicit [coding-agent](wiki.html#definition-coding-agent) delegation through `--agent`, and automatic selection when those options are absent. It must protect an existing output file unless the caller explicitly supplies `--force`.

ALA must execute general language requests without requiring a [task repository](wiki.html#definition-task-repository). It must discover Anthropic task skills independently from AchillesAgentLib and must execute selected task skills through an available [coding agent](wiki.html#definition-coding-agent). Specialized task methodology and task-specific verification rules must remain in independently versioned task repositories.

A task skill is an Anthropic-style declaration supplied by a task repository through `SKILL.md`. It packages instructions and optional supporting resources for one coherent task, must declare `name` and `description` frontmatter, and must not require an AchillesAgentLib descriptor or proprietary wrapper.

ALA is not a general repository-owning coding agent. A task skill may request bounded code generation or an authenticated coding agent, but language processing, planning, research, documentation, transformation, and verification define ALA's primary domain.

The npm package is `advanced-language-agent`, uses ECMAScript modules on Node.js 20 or newer, and exposes `ala` through its `bin` mapping. Exit codes must distinguish success, usage and configuration errors, input errors, repository or task-skill errors, execution errors, and interruption without writing diagnostics to the result stream.

## Conclusion

ALA provides a stable language-task interface and shared execution services while independent task skills retain ownership of domain methods.
