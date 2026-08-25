---
title: DS006-workspaces-sessions-and-feedback
summary: Defines isolated multi-stage work, interactive correction, verification, and bounded escalation.
---

## Introduction

Some task skills require several stages, retained conversational context, or independent verification. [ALA](index.html) provides those generic facilities without taking ownership of the caller's software repository.

## Core Content

Every Anthropic task skill must execute inside an isolated temporary [task workspace](wiki.html#definition-task-workspace). The workspace may hold explicit input material, retrieved sources, intermediate outputs, verification results, and final artifacts. It must not become an implicit copy of the caller's repository or a general persistent project directory.

Every [coding-agent](wiki.html#definition-coding-agent) execution must create its task workspace lazily and must use it as the agent's project directory. ALA must link each discovered Anthropic skill directory under `.agents/skills/<name>` so the agent can read `SKILL.md` and relative resources without copying the repository. The public CLI must not accept the caller's repository or another persistent directory for this path. A runtime must reuse one workspace during native agent continuation and must remove it when the runtime closes.

Running `ala` without an instruction in a terminal or supplying `--interactive` must start an interactive session. A [MainAgent](wiki.html#definition-main-agent)-selected session must retain its [AchillesAgentLib](wiki.html#definition-achilles-agent-lib) conversation, while a session using `--skill` must retain the selected task skill, coding-agent backend, native continuation, and previous result for corrective instructions. When both interactive input and the diagnostic stream are terminals, ALA must render a single-line three-frame `Thinking` animation during MainAgent and coding-agent execution. It must stop the timer and erase the line in a finalization path for success, failure, and interruption, and it must not render the animation for redirected input, redirected diagnostics, local slash commands, or single-shot execution. `:quit` and `:exit` must close the session, and interruption must cancel the active AchillesAgentLib or coding-agent session.

An interactive session using `--agent` must retain the backend's opaque native continuation identifier and pin later prompts to that backend. A request to change the backend after continuation begins must fail instead of creating an unrelated conversation. Interruption must terminate the active child process and retain exit code `130` semantics.

Interactive `/help`, `/agent list`, `/agent help`, `/agent <codex|opencode|pi> models`, `/agent <codex|opencode|pi> model <model-name>`, `/agent auto <prompt>`, `/agent <codex|opencode|pi> <prompt>`, `/repo add <git-url>`, `/repo list`, `/repo remove <name-or-path-or-git-url>`, `/symbolic detection on|off`, and `/websearch on|off` commands must be parsed by the CLI before ordinary prompt execution. Model listing must print the native backend model identifiers one per line, and model selection must save the identifier atomically before applying it to later invocations without clearing the current workspace or native continuation. Web-search selection must save a Boolean atomically and apply it to later coding-agent invocations without clearing that state. `/repo add` must reject local paths. `/help`, `/agent`, and `/agent help` must print the same complete list of supported interactive commands and explain what each command does. The four `/quit`, `/exit`, `:quit`, and `:exit` exit forms must appear as one grouped help entry. In an interactive terminal, TAB after `/repo remove ` or a partial repository name must complete matching short names from the current persistent configuration, and successful repository changes must update those candidates. A repository addition or removal must refresh the task-skill catalog for the next prompt without replacing MainAgent, changing symbolic detection or web-search state, deleting coding-agent workspace files, changing the selected backend, or clearing the native continuation. The refresh must replace only the links under `.agents/skills` so removed skills disappear and added skills become available in the same coding-agent session. Local command output and errors must not be submitted to MainAgent or an LLM.

Single-shot input must accept ordered text, UTF-8 file, HTTP(S), and standard-input payloads. Each file or URL response must be limited to 10 MiB, the combined payload must be limited to 32 MiB, and URL retrieval must stop after 30 seconds. Without a positional instruction in a non-interactive pipeline, standard input must supply the instruction; with a positional instruction, `--stdin` must add standard input as payload.

Interactive correction must preserve the task method unless the caller explicitly selects another task. Verification failure may cause ALA to move from a fast model to a stronger model or from direct execution to bounded [agentic execution](wiki.html#definition-agentic-execution).

Retries must have a finite configured limit. Workspace cleanup, retention, and sensitive-data handling must follow a documented deployment policy. Until that policy selects persistence guarantees, implementations must keep workspace scope isolated to one request and must not promise artifact retention.

[Task repositories](wiki.html#definition-task-repository) supply Anthropic `SKILL.md` instructions for coding agents. Those instructions must define task methodology, required checks, and acceptance conditions. The coding agent supplies planning, tools, and execution; the task skill continues to own domain procedure.

## Conclusion

ALA supports complex work through isolated task material, retained feedback context, verification, and finite escalation without assuming ownership of caller repositories.
