---
title: DS003-main-behavior
summary: Defines ALA request execution, optional task repositories, A-Skill selection, and configured AchillesAgentLib execution.
---

## Introduction

[Advanced Language Agent (ALA)](index.html) lets a human or calling agent submit a language-oriented task through the `ala` command and receive the requested result without integrating [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) or a model provider directly. This specification contains the implemented behaviors that determine that user outcome.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Single-shot and interactive request execution | A human or agent supplies an instruction and optional payloads, and ALA returns a clean result once or across a retained interactive session. |
| Optional [task repositories](wiki.html#definition-task-repository) and [A-Skill](wiki.html#definition-a-skill) selection | ALA works with an empty catalog and lets operators add independently owned task methods that can be selected automatically or explicitly. |
| Configured AchillesAgentLib execution | ALA resolves AchillesAgentLib, applies model and runtime overrides, runs the request through [MainAgent](wiki.html#definition-main-agent), preserves cancellation and cleanup, and returns the result. |

### Single-shot and interactive request execution

A human or calling agent starts this behavior with `ala [options] [instruction...]`. ALA must combine positional instruction text with ordered `--text`, `--file`, `--url`, and `--stdin` payloads, then execute the resulting prompt in single-shot mode or retain a conversation when `--interactive` is supplied or a terminal starts without an instruction. In a non-interactive pipeline without positional text, standard input must become the instruction.

The observable result must contain only the requested content on standard output or in the file selected by `--output`. Diagnostics and interactive prompts must use standard error. ALA must refuse to replace an existing output file unless the caller supplies `--force`, limit each file or URL payload to 10 MiB, limit their aggregate size to 32 MiB, stop URL retrieval after 30 seconds, and convert interruption into exit code `130`. These hidden protections prevent an accepted request from consuming unbounded input or silently destroying an existing result file. DS006 defines the detailed session and input contracts.

### Optional task repositories and A-Skill selection

An operator may use ALA without registering a task repository; an empty [skill catalog](wiki.html#definition-skill-catalog) must remain a valid state for general execution. The commands `ala repo add <path>`, `ala repo list`, and `ala repo remove <path>` must respectively validate and persist a repository, display persistent registrations, and unregister a path without deleting repository content. Persistent repositories must combine with `ALA_TASK_REPOSITORIES` and repeated `--task-repo` values for the active process.

ALA must validate supported AchillesAgentLib descriptors, deduplicate canonical repository paths, reject duplicate canonical A-Skill names, and expose the combined catalog through an isolated [discovery registry](wiki.html#definition-discovery-registry). When `--skill <name>` is present, ALA must execute that named A-Skill or return repository exit code `4`. Without `--skill`, MainAgent must execute generally when the catalog is empty and may select an available skill when the catalog is populated. The owning task repository retains its files, documentation, procedure, and acceptance conditions. DS004 and DS005 define repository and routing details.

### Configured AchillesAgentLib execution

Every accepted request must pass through a resolved AchillesAgentLib MainAgent and its [LLMAgent](wiki.html#definition-llm-agent). ALA must resolve the library from `--achilles-path` or `ACHILLES_AGENT_LIB_PATH`, then a sibling checkout, then the installed `ploinky-agent-lib` package. A selected path that cannot be loaded must stop execution with repository exit code `4` instead of silently choosing another source.

ALA must apply `--model`, repeated `--tag`, and `--reasoning-effort` before the corresponding `ALA_MODEL`, `ALA_TAGS`, and `ALA_REASONING_EFFORT` values. `--model-config` must set the resolved `LLM_MODELS_CONFIG_PATH` before AchillesAgentLib initializes. The runtime must retain MainAgent for the active interactive session, forward interruption to the active session, normalize the returned result, shut MainAgent down, and remove the discovery registry. These hidden lifecycle actions ensure that model choice reaches the executor, feedback reaches the same conversation, interruption reaches active work, and temporary discovery state does not survive the process. DS001 and DS002 define dependency and model-selection constraints.

[Symbolic routing](wiki.html#definition-symbolic-routing), authenticated coding-agent use, research access, [task workspaces](wiki.html#definition-task-workspace), retry escalation, [Ploinky](wiki.html#definition-ploinky) hosting, and [routing evaluation](wiki.html#definition-routing-evaluation) remain specialized design contracts in DS002 and DS005 through DS007. They are not part of this implemented Main Behavior set until source and tests establish their principal runtime paths.

## Conclusion

ALA fulfills its purpose by accepting single-shot and interactive requests, optionally extending execution through independently owned task repositories and A-Skills, and running the result-producing path through configured AchillesAgentLib components while preserving clean output and bounded lifecycle behavior.
