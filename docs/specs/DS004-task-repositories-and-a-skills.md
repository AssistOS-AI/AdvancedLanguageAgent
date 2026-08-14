---
title: DS004-task-repositories-and-a-skills
summary: Defines independently versioned task families and their AchillesAgentLib A-Skill contract.
---

## Introduction

A [task repository](wiki.html#definition-task-repository) packages one coherent family of work, such as translation, scientific-reference verification, controlled-language transformation, SOP Lang planning, scientific writing, or web research. Task repositories evolve independently from [ALA](index.html) and from one another.

## Core Content

An [A-Skill](wiki.html#definition-a-skill) is a reusable [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) skill inside a task repository. It uses the conventions of its AchillesAgentLib skill family and supplies task instructions, constraints, validation rules, and optional code. ALA must not translate it into a proprietary skill representation.

Task repositories are optional extensions. ALA must remain usable for general requests when no repository is registered, supplied through the environment, or added for an invocation. The absence of repositories must produce an empty [skill catalog](wiki.html#definition-skill-catalog) rather than a repository error.

Each task repository must describe the request class it covers, positive and conflicting selection evidence, expected inputs and outputs, available A-Skills, constraints, verification procedures, and [generic ALA execution capabilities](wiki.html#definition-generic-execution-capability) its skills may request. The description must participate in routing and must not serve only as human documentation.

An A-Skill must own domain methodology and acceptance conditions while delegating model calls, agent execution, research access, and temporary workspace creation to ALA. It may be implemented as an AchillesAgentLib [Code Skill](wiki.html#definition-code-skill) (`cskill.md`), [Orchestration Skill](wiki.html#definition-orchestration-skill) (`oskill.md`), [DBTable Skill](wiki.html#definition-dbtable-skill) (`tskill.md`), [Dynamic Code Generation Skill](wiki.html#definition-dynamic-code-generation-skill) (`dcgskill.md`), or another runtime-compatible family.

ALA must persist task repository paths in a versioned JSON configuration at `$XDG_CONFIG_HOME/ala/config.json`, falling back to `~/.config/ala/config.json`. `--config` and `ALA_CONFIG_PATH` must be able to select another configuration file. `ala repo add` must validate and canonically store a repository path, repeated addition must be idempotent, `ala repo list` must expose the stored paths, and `ala repo remove` must remove only the registration without deleting repository content.

ALA must combine persistent repositories with the platform-delimited `ALA_TASK_REPOSITORIES` value and repeated invocation-specific `--task-repo` options. It must deduplicate canonical paths, discover AchillesAgentLib descriptors below each repository, reject empty repositories and duplicate canonical A-Skill names, and expose the combined skill catalog to one [MainAgent](wiki.html#definition-main-agent) through an isolated temporary [discovery registry](wiki.html#definition-discovery-registry) that is removed after execution.

Repositories must remain independently installable, configurable, and versionable. Imported A-Skill documentation and specifications must remain in the owning task repository and must not be copied into ALA's `docs/` tree.

The stable semantic requirements above do not select concrete manifest filenames or serialization. Automatic routing must not depend on undocumented metadata fields until an implementation contract defines them.

## Conclusion

Task repositories extend ALA with specialized methods, and AchillesAgentLib A-Skills define those methods while ALA remains capable of general execution and provides generic execution services.
