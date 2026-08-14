---
title: DS000-vision
summary: Defines the purpose, user-visible result, and product boundary of Advanced Language Agent.
---

## Introduction

[Advanced Language Agent (ALA)](index.html) is a system-installed command-line interface for language-oriented and documentation-oriented work. It gives human and agent callers one stable interface for reusable task methods without requiring them to integrate [AchillesAgentLib](wiki.html#definition-achilles-agent-lib), model providers, research tools, or coding agents directly.

## Core Content

ALA must support interactive and single-shot requests. A caller must be able to provide an instruction and optional input through command arguments, standard input, a URL, or a file. ALA must write the requested result to standard output or a file and must keep diagnostics and routing information separate from that result.

The distribution executable is `ala`. It must accept positional instructions, explicit payload-source options, explicit [A-Skill](wiki.html#definition-a-skill) selection through `--skill`, and automatic selection when that option is absent. It must protect an existing output file unless the caller explicitly supplies `--force`.

ALA must execute general language requests without requiring a [task repository](wiki.html#definition-task-repository). It must also own [generic execution capabilities](wiki.html#definition-generic-execution-capability) for task and skill discovery, task routing, model and agent execution, research access, temporary workspaces, sessions, verification support, and bounded retries. Specialized task methodology and task-specific verification rules must remain in independently versioned task repositories.

An A-Skill is a reusable AchillesAgentLib skill supplied by a task repository. It packages instructions and optional code for one coherent task. The term identifies an AchillesAgentLib skill in ALA's task-facing role and does not establish a second skill representation.

ALA is not a general repository-owning coding agent. An A-Skill may request bounded code generation or an authenticated coding agent, but language processing, planning, research, documentation, transformation, and verification define ALA's primary domain.

The npm package is `advanced-language-agent`, uses ECMAScript modules on Node.js 20 or newer, and exposes `ala` through its `bin` mapping. Exit codes must distinguish success, usage and configuration errors, input errors, repository or A-Skill errors, execution errors, and interruption without writing diagnostics to the result stream.

## Conclusion

ALA provides a stable language-task interface and shared execution services while independent AchillesAgentLib A-Skills retain ownership of domain methods.
