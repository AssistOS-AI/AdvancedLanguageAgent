---
title: DS004-task-repositories-and-a-skills
summary: Defines independently versioned task families and their SKILL.md task contract.
---

## Introduction

A [task repository](wiki.html#definition-task-repository) packages one coherent family of work, such as translation, scientific-reference verification, controlled-language transformation, SOP Lang planning, scientific writing, or web research. Task repositories evolve independently from [ALA](index.html) and from one another.

## Core Content

A task skill is an Anthropic-style declaration in `SKILL.md` inside a task repository. Its YAML frontmatter must supply a lowercase hyphenated `name` and a non-empty `description`; its Markdown body supplies task instructions, constraints, examples, validation rules, and references to optional resources relative to the skill directory. ALA must not require or generate an AchillesAgentLib descriptor for it.

Task repositories are optional extensions. ALA must remain usable for general requests when no repository is registered or supplied through the environment. The absence of repositories must produce an empty [skill catalog](wiki.html#definition-skill-catalog) rather than a repository error.

Each task skill's `description` must identify the request class it covers and must participate in coding-agent catalog selection. The Markdown body owns expected inputs and outputs, constraints, verification procedures, and supporting-resource instructions. An optional `## Symbolic Routing` section may supply deterministic routing evidence without changing the Anthropic descriptor contract.

An Anthropic task skill must own domain methodology and acceptance conditions. ALA must execute it only through a detected [coding agent](wiki.html#definition-coding-agent), mount its directory strictly read-only under `/workspace/.agents/skills/<name>` in the Bubblewrap workspace, and allow the agent to resolve supporting resources relative to that directory without granting write access to the owning repository.

ALA's generic [Code Skill](wiki.html#definition-code-skill) is an internal bridge from MainAgent to the coding-agent service. ALA must ignore `cskill.md`, `oskill.md`, `tskill.md`, and `dcgskill.md` in task repositories, and task skills must not import backend adapters or inspect agent credentials.

ALA must persist task repository paths in a versioned JSON configuration at `~/.config/ala/config.json`. `ALA_CONFIG_PATH` must select another configuration file, and `--config` must have the highest priority for one command. `ala repo add` and interactive `/repo add` must accept only a Git URL and reject local paths. The Git URL must map deterministically to a managed clone under `$XDG_DATA_HOME/ala/repositories`, falling back to `~/.local/share/ala/repositories`, and configuration must store its canonical local path without exposing embedded URL credentials. Local repository paths must enter discovery only through the platform-delimited `ALA_TASK_REPOSITORIES` environment value.

The managed clone must remove its `origin` remote after cloning so the source URL and any embedded credential are not retained. Repeated addition must be idempotent and must not update an existing managed clone. `ala repo list` and `/repo list` must expose stored paths. `ala repo remove` and `/repo remove` must accept the Git repository name without `.git`, registered path, or original Git URL and remove only the registration without deleting repository content or a managed clone. The short name must derive from the final Git URL component and remain recoverable from the managed clone name after its deterministic hash suffix is removed. If two registrations share that name, the short form must fail as ambiguous and require an exact registered path or Git URL.

Interactive repository management must be local and must not submit its arguments or output to MainAgent or an LLM. After an addition or removal, ALA must resolve all persistent and environment-provided repositories again, validate the combined catalog, and expose that catalog to the next prompt in the same session. This refresh must leave the AchillesAgentLib discovery registry, MainAgent conversation, coding-agent workspace files, active folder mounts, selected backend, native continuation, and symbolic-detection setting active because task descriptors never enter that registry. It must replace only the strict read-only skill mount set for the next coding-agent process and report the refreshed skill count. If combined validation or workspace mount preparation fails, ALA must restore the previous persistent registration, leave the active catalog and mount set unchanged, and report the repository error locally.

ALA must combine persistent repositories with the platform-delimited `ALA_TASK_REPOSITORIES` value. It must deduplicate canonical paths, recursively discover files named exactly `SKILL.md`, reject empty repositories and duplicate task-skill names, and keep the combined catalog separate from the AchillesAgentLib [discovery registry](wiki.html#definition-discovery-registry). With a coding agent available, ALA must expose discovered skill directories only through strict read-only bind mounts in that agent's temporary workspace. With no coding agent available, general MainAgent execution must remain available when no folder mount is active, while explicit `--skill` or folder-forced execution must fail with execution exit code `5`.

Repositories must remain independently installable, configurable, and versionable. Imported task skill documentation and specifications must remain in the owning task repository and must not be copied into ALA's `docs/` tree.

Automatic catalog selection must use the Anthropic `name` and `description` fields. ALA may use the documented optional `## Symbolic Routing` section only when symbolic detection is enabled and must not depend on other undocumented metadata fields.

## Conclusion

Task repositories extend ALA with Anthropic `SKILL.md` methods that coding agents execute, while AchillesAgentLib remains responsible for general model execution and ALA's internal coding-agent bridge.
