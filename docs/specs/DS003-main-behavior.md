---
title: DS003-main-behavior
summary: Defines ALA request execution, optional task methods, configured AchillesAgentLib execution, symbolic routing, and authenticated coding-agent delegation.
---

## Introduction

[Advanced Language Agent (ALA)](index.html) lets a human or calling agent submit a language-oriented task through the `ala` command and receive the requested result without integrating [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) or a model provider directly. This specification contains the implemented behaviors that determine that user outcome.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Single-shot and interactive request execution | A human or agent supplies an instruction and optional payloads, and ALA returns a clean result once or across a retained interactive session. |
| Optional [task repositories](wiki.html#definition-task-repository) and [task skill](wiki.html#definition-a-skill) selection | ALA works with an empty catalog and lets operators add independently owned task methods that can be selected automatically or explicitly. |
| Configured AchillesAgentLib execution | ALA resolves AchillesAgentLib, applies model and runtime overrides, runs the request through [MainAgent](wiki.html#definition-main-agent), preserves cancellation and cleanup, and returns the result. |
| Authenticated coding-agent delegation | ALA detects installed agent CLIs, lets callers or MainAgent delegate complex work, and retains the selected agent in a temporary workspace without requiring a direct provider key. |
| Experimental symbolic task routing | ALA can inspect only the instruction, select a clearly matching task skill from declared routing metadata, and safely return uncertain requests to MainAgent. |

### Single-shot and interactive request execution

A human or calling agent starts this behavior with `ala [options] [instruction...]`. ALA must combine positional instruction text with ordered `--text`, `--file`, `--url`, and `--stdin` payloads, then execute the resulting prompt in single-shot mode or retain a conversation when `--interactive` is supplied or a terminal starts without an instruction. In a non-interactive pipeline without positional text, standard input must become the instruction. During an interactive session, lines beginning with `/` must be interpreted as local commands; `/agent` commands must execute the selected coding-agent service or report its local status without reaching MainAgent or an LLM.

The observable result must contain only the requested content on standard output or in the file selected by `--output`. Diagnostics and interactive prompts must use standard error. ALA must refuse to replace an existing output file unless the caller supplies `--force`, limit each file or URL payload to 10 MiB, limit their aggregate size to 32 MiB, stop URL retrieval after 30 seconds, and convert interruption into exit code `130`. These hidden protections prevent an accepted request from consuming unbounded input or silently destroying an existing result file. DS006 defines the detailed session and input contracts.

### Optional task repositories and task skill selection

ALA must validate task repositories containing `SKILL.md` manifests, deduplicate canonical repository paths, reject duplicate canonical task-skill names, and expose the combined catalog through an isolated [discovery registry](wiki.html#definition-discovery-registry). When `--skill <name>` is present, ALA must execute that named task skill or return repository exit code `4`. Without `--skill`, MainAgent must execute generally when the catalog is empty and may select an available skill when the catalog is populated. The owning task repository retains its files, documentation, procedure, and acceptance conditions. DS004 and DS005 define repository and routing details.

### Configured AchillesAgentLib execution

Every accepted request must pass through a resolved AchillesAgentLib MainAgent. Direct model execution must use its [LLMAgent](wiki.html#definition-llm-agent), while explicit coding-agent execution must use MainAgent's Code Skill subsystem without making an LLMAgent model call. ALA must resolve the library from `--achilles-path` or `ACHILLES_AGENT_LIB_PATH`, then a sibling checkout, then the installed `ploinky-agent-lib` package. A selected path that cannot be loaded must stop execution with repository exit code `4` instead of silently choosing another source.

ALA must apply `--model`, repeated `--tag`, and `--reasoning-effort` before the corresponding `ALA_MODEL`, `ALA_TAGS`, and `ALA_REASONING_EFFORT` values. `--model-config` must set the resolved `LLM_MODELS_CONFIG_PATH` before AchillesAgentLib initializes. The runtime must retain MainAgent for the active interactive session, forward interruption to the active session, normalize the returned result, shut MainAgent down, and remove the discovery registry. These hidden lifecycle actions ensure that model choice reaches the executor, feedback reaches the same conversation, interruption reaches active work, and temporary discovery state does not survive the process. DS001 and DS002 define dependency and model-selection constraints.

### Experimental symbolic task routing

An interactive user enables this behavior with `/symbolic detection on` and disables it with `/symbolic detection off`; the default session state is disabled. When enabled, ALA extracts symbolic evidence from the instruction only and compares it with `## Symbolic Routing` metadata declared by task skills. A `DETERMINISTIC` or sufficiently strong `HIGH` match executes the selected task skill directly. `AMBIGUOUS` and `UNKNOWN` results abstain and return to the MainAgent-compatible route. Payload contents must not increase symbolic confidence, and explicit `--skill` or `--agent` selection takes precedence. DS005 defines the metadata and state contract.

Research access, general task-workspace requests, retry escalation, [Ploinky](wiki.html#definition-ploinky) hosting, and [routing evaluation](wiki.html#definition-routing-evaluation) remain specialized contracts in DS002 and DS005 through DS007.

### Authenticated coding-agent delegation

A human, calling agent, or MainAgent-selected execution path may delegate a bounded complex request to an installed [coding agent](wiki.html#definition-coding-agent). `ala agent list` must report Codex, OpenCode, and Pi executable discovery without starting a model session. `--agent auto` must force delegation through the first available configured backend, and `--agent codex`, `--agent opencode`, or `--agent pi` must select that available backend explicitly. `--agent` and `--skill` must remain mutually exclusive because one selects generic execution while the other selects a task method.

When at least one backend is detected, ALA must add its generic `coding-agent` Code Skill to the same process-scoped discovery registry used by MainAgent. This skill is runtime infrastructure and must not be counted as a task-specific task skill. ALA must create a private temporary workspace for the first delegated prompt, pass that directory instead of the caller's repository, preserve the backend's native continuation identifier, pin subsequent interactive prompts to the same backend, and remove the workspace at shutdown. These hidden boundaries let subscription-authenticated agents perform multi-step work without transferring repository ownership or credentials to ALA. DS002 and DS006 define backend and workspace details.

## Conclusion

ALA fulfills its purpose by accepting single-shot and interactive requests, optionally extending execution through independently owned task repositories and task skills, and running work through configured AchillesAgentLib components or a detected authenticated coding agent while preserving clean output and bounded lifecycle behavior.
