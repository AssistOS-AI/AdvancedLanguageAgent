---
title: DS003-main-behavior
summary: Defines ALA request execution, Anthropic task-skill discovery, configured AchillesAgentLib execution, symbolic routing, and coding-agent delegation.
---

## Introduction

[Advanced Language Agent (ALA)](index.html) lets a human or calling agent submit a language-oriented task through the `ala` command and receive the requested result without integrating [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) or a model provider directly. This specification contains the implemented behaviors that determine that user outcome.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Single-shot and interactive request execution | A human or agent supplies an instruction and optional payloads, and ALA returns a clean result once or across a retained interactive session. |
| Optional [task repositories](wiki.html#definition-task-repository) and [task skill](wiki.html#definition-a-skill) selection | ALA discovers Anthropic `SKILL.md` descriptors and lets a coding agent select a task method automatically or execute one selected explicitly. |
| Configured AchillesAgentLib execution | ALA resolves AchillesAgentLib, applies model and runtime overrides, runs the request through [MainAgent](wiki.html#definition-main-agent), preserves cancellation and cleanup, and returns the result. |
| Authenticated coding-agent delegation | ALA detects installed agent CLIs, executes every agent process inside Bubblewrap, and uses either a caller-selected persistent cwd/home or an owned temporary workspace. |
| Experimental symbolic task routing | ALA can inspect only the instruction, select a clearly matching task skill from declared routing metadata, and leave uncertain selection to the coding agent. |

### Single-shot and interactive request execution

A human or calling agent starts this behavior with `ala [options] [instruction...]`. ALA must combine positional instruction text with ordered `--text`, `--file`, `--url`, and `--stdin` payloads, and also accept orchestration-oriented `--task` or `--taskFile` prompts. Each process builds a new runtime and exposes no conversation or native continuation to a later process. Coding-agent execution uses the existing `--cwd` directory when supplied and otherwise creates and later removes a temporary workspace. `--home` selects the coding-agent configuration home. During an interactive session, lines beginning with `/` are local commands; arbitrary folder-mount commands are not supported.

The observable result must contain only the requested content on standard output or in the file selected by `--output`. Diagnostics, interactive prompts, and supported live coding-agent events must use standard error. While terminal input and standard error are both interactive, every MainAgent or coding-agent wait must display a repeating `Thinking.`, `Thinking..`, and `Thinking...` status on one diagnostic line. The first live coding-agent event must clear and stop that indicator before visible assistant, command, tool, or native provider output is written, while the normalized final answer remains the standard-output result. The status must clear on success, failure, or interruption and remain disabled for redirected or non-interactive streams. ALA must refuse to replace an existing output file unless the caller supplies `--force`, limit each file or URL payload to 10 MiB, limit their aggregate size to 32 MiB, stop URL retrieval after 30 seconds, and convert interruption into exit code `130`. These hidden protections prevent an accepted request from consuming unbounded input, contaminating machine-readable output, or silently destroying an existing result file. DS006 defines the detailed session and input contracts.

### Optional task repositories and task skill selection

ALA must recursively discover Anthropic `SKILL.md` manifests, validate their `name` and `description` frontmatter, deduplicate canonical repository paths, and reject duplicate task-skill names. It must not search task repositories for AchillesAgentLib skill descriptors or expose Anthropic descriptors through the AchillesAgentLib [discovery registry](wiki.html#definition-discovery-registry). Persistent `repo add` commands accept only a Git URL and clone it into the ALA data directory; `ALA_TASK_REPOSITORIES` may supply local repository paths. Repository additions and removals in an interactive session refresh the active catalog while retaining MainAgent conversation, workspace files, selected backend, and native continuation. `--skill <name>` selects an exact task skill or returns repository exit code `4`, then executes through an available coding agent or returns execution exit code `5`. Without `--skill`, a coding agent selects from a populated catalog; MainAgent executes generally only when the catalog is empty and no explicit coding-agent route was selected. DS004 and DS005 define repository and routing details.

### Configured AchillesAgentLib execution

Every accepted request must pass through a resolved AchillesAgentLib MainAgent. Direct model execution must use its [LLMAgent](wiki.html#definition-llm-agent), while explicit coding-agent execution must use MainAgent's Code Skill subsystem without making an LLMAgent model call. ALA must resolve the library from `--achilles-path` or `ACHILLES_AGENT_LIB_PATH`, then a sibling checkout, then the installed `ploinky-agent-lib` package. A selected path that cannot be loaded must stop execution with repository exit code `4` instead of silently choosing another source.

ALA must apply `--model`, repeated `--tag`, and `--reasoning-effort` before the corresponding `ALA_MODEL`, `ALA_TAGS`, and `ALA_REASONING_EFFORT` values. `--model-config` must set the resolved `LLM_MODELS_CONFIG_PATH` before AchillesAgentLib initializes. The runtime must retain MainAgent for the active interactive session, forward interruption to the active session, normalize the returned result, shut MainAgent down, and remove the discovery registry. These hidden lifecycle actions ensure that model choice reaches the executor, feedback reaches the same conversation, interruption reaches active work, and temporary discovery state does not survive the process. DS001 and DS002 define dependency and model-selection constraints.

### Experimental symbolic task routing

An interactive user enables this behavior with `/symbolic detection on` and disables it with `/symbolic detection off`; the default session state is disabled. When enabled, ALA extracts symbolic evidence from the instruction only and compares it with `## Symbolic Routing` metadata declared by task skills. A `DETERMINISTIC` or sufficiently strong `HIGH` match selects one skill before coding-agent execution. `AMBIGUOUS` and `UNKNOWN` results abstain from deterministic selection and let the coding agent inspect the full catalog. Payload contents must not increase symbolic confidence, and explicit `--skill` or `--agent` selection takes precedence. DS005 defines the metadata and state contract.

Research access, general task-workspace requests, retry escalation, [Ploinky](wiki.html#definition-ploinky) hosting, and [routing evaluation](wiki.html#definition-routing-evaluation) remain specialized contracts in DS002 and DS005 through DS007.

### Authenticated coding-agent delegation

A human, calling agent, or MainAgent-selected execution path may delegate a bounded complex request to an installed [coding agent](wiki.html#definition-coding-agent). `ala agent list` must report Codex, OpenCode, and Pi executable discovery without starting a model session. Interactive `/agent <name> models` must list identifiers from the selected backend's native catalog, `/agent <name> model <model-name>` must persist and immediately apply that backend's selection, and `/agent <name> model default` must delete the persisted override and immediately restore native agent-default selection. `--ca auto|codex|opencode|pi` is the orchestration-facing selector and `--agent` remains its compatibility spelling. Explicit coding-agent selection and `--skill` remain mutually exclusive. `--model` may be passed as a native coding-agent model hint when `--ca` is used.

Web search must be disabled by default for coding-agent execution. Bare `--websearch` must enable it only for its process, `--websearch on|off` must provide the explicit invocation override, and interactive `/websearch on|off` must save `codingAgents.websearch` atomically and update the current coding-agent service without replacing its workspace, backend selection, or native continuation. ALA must propagate that state through native controls for Codex and OpenCode. It must leave Pi unchanged rather than adding a third-party capability, and it must not persist search credentials or bypass provider or source-site limits.

When at least one backend is detected, ALA must add its generic `coding-agent` Code Skill to the process-scoped discovery registry used by MainAgent. This internal skill is runtime infrastructure and must not be counted as a task-specific task skill. ALA uses an explicit `--cwd` as the persistent host workspace or creates a private temporary workspace when omitted, exposing it at `/workspace`. An explicit `--home` supplies persistent backend configuration and authentication state. Selected Anthropic skill directories are mounted strictly read-only under `/workspace/.agents/skills/<name>`. ALA preserves the backend's native continuation inside a session and removes only temporary workspaces it created. The installed backend and runtime are mounted read-only and are never installed into the workspace. Arbitrary host-folder mounts are unsupported. DS002 and DS006 define backend and workspace details.

## Conclusion

ALA fulfills its purpose by accepting single-shot and interactive requests, optionally extending execution through independently owned task repositories and task skills, and running work through configured AchillesAgentLib components or a detected authenticated coding agent while preserving clean output and bounded lifecycle behavior.
