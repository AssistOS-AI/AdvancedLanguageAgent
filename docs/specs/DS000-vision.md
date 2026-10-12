---
title: DS000-vision
summary: Defines the purpose, user-visible result, and product boundary of Advanced Language Agent.
---

## Introduction

[Advanced Language Agent (ALA)](index.html) is a system-installed command-line interface for language-oriented and documentation-oriented work. It gives human and agent callers one stable interface without requiring them to integrate model providers, research tools, sandboxing, or [coding agents](wiki.html#definition-coding-agent) directly.

## Core Content

ALA must support interactive and single-shot requests. A caller must be able to provide an instruction and optional input through command arguments, standard input, a URL, or a file. ALA must write the requested result to standard output or a file and must keep diagnostics and routing information separate from that result.

The distribution executable is `ala`. It must accept positional instructions, explicit payload-source options, explicit coding-agent selection through `--agent` or `--ca`, and automatic selection (`auto`) when those options are absent. It must mount exactly the directories supplied through `--cwd` and `--folder` and must protect an existing output file unless the caller explicitly supplies `--force`.

ALA must run every request on an available coding agent without relying on any external task catalog, and must fail with an execution error before doing any work when no coding agent is available. It must never infer task-skill mounts or prepare task skills; callers own their directory layout and task methodology.

ALA is not a general repository-owning coding agent. It may delegate bounded code generation to an authenticated coding agent, but language processing, planning, research, documentation, transformation, and verification define ALA's primary domain.

The npm package is `advanced-language-agent`, uses ECMAScript modules on Node.js 20 or newer, and exposes `ala` through its `bin` mapping. Exit codes must distinguish success, usage and configuration errors, input errors, execution errors, and interruption without writing diagnostics to the result stream.

## Conclusion

ALA provides a stable language-task interface and shared execution services while callers retain ownership of their working directories and methods.
