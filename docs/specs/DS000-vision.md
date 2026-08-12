---
id: DS000
title: ALA vision
status: active
owner: ALA maintainers
summary: Defines the purpose, boundary, and user-visible contract of Advanced Language Agent.
---

## Introduction

Advanced Language Agent (ALA) is a system-installed CLI for language-oriented and documentation-oriented work. An A-Skill is an Achilles skill that supplies the method for one task family.

## Core Content

ALA must provide one stable interface for interactive and single-shot requests. It must accept instructions and optional inputs from arguments, standard input, URLs, or files, and return the requested result through standard output or a file. Diagnostics and routing information must remain separate from the result stream.

ALA must remain a generic execution substrate. Task-specific behavior belongs to independently versioned task repositories and their A-Skills. ALA must provide routing, LLM and agent execution, research access, temporary workspaces, and bounded feedback retries.

## Decisions & Questions

### Question #1: Which product boundary is normative?

Response: The normative product is the stable ALA CLI and its generic execution substrate. Repository layout and implementation phase are not part of the user-facing contract.

### Question #2: What is the dependency boundary?

Response: The design reuses AchillesAgentLib/MainAgent conventions and compatible model configuration where available. Exact packaging remains unresolved.

## Conclusion

ALA preserves the generic execution boundary and keeps task methodology in A-Skills.
