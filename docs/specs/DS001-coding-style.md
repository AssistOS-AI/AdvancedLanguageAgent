---
title: DS001-coding-style
summary: Defines source layout, dependency rules, file limits, documentation rules, and modular verification.
---

## Introduction

This specification is the canonical source for [ALA](index.html) coding style, source layout, file-size rules, and test organization.

## Core Content

ALA runtime code must use ECMAScript modules unless an affected specification states a justified exception. Production runtime, tests, configuration, and persistent data should use clear `src/`, `tests/`, and `data/` boundaries. Generic runtime code must remain separate from any caller-owned working directory and its content.

Modules should have one responsibility, descriptive names, explicit entry points, and documented input, output, diagnostic, and failure behavior. Standard output must remain reserved for requested results. Modules should remain below 500 lines; files above 800 lines require decomposition. Code should normally keep lines within 120 characters, and code lines longer than 300 characters require review. Documentation prose blocks must remain unwrapped in HTML and Markdown source even when they exceed those code-oriented line-length thresholds. The repository-level `fileSizesCheck.sh` is the canonical mechanical check.

`package.json` declares no runtime npm dependencies; the runtime relies on Node.js built-ins, Linux Bubblewrap, and already installed [coding-agent](wiki.html#definition-coding-agent) CLIs. Any new external dependency must be justified in `dependencies.md`. All model interactions must run through the selected coding agent's native CLI, launched by the coding-agent service in `src/coding-agents/service.mjs`; ALA must not call model providers itself. Runtime configuration must combine environment-derived defaults with explicit manual overrides, and manual values must take precedence. Implementation and documentation must not hard-code a workstation path.

ALA implements and distributes no runtime skills. It must not discover or prepare external task skills or infer their mounts, and its runtime code must never reinterpret `cskill.md`, `oskill.md`, `tskill.md`, or `dcgskill.md` as its own task descriptors. ALA mounts only the caller-supplied `--cwd` and `--folder` directories and must preserve the coding-agent service, mounted directories, selected backend, and native continuation across an interactive session.

Model selection must follow DS002 rather than embedding provider-specific model names throughout task code.

Tests must be modular and grouped by concern. CLI input handling, output separation, coding-agent selection, missing-agent failure, mount layout, workspace lifecycle, configuration precedence, and retry bounds require independent tests. Tests must use deterministic fakes or contract fixtures and must not require real credentials.

Coding-agent process adapters must use argument-array child-process invocation without a shell, pass every execution and native model-catalog process through the common Bubblewrap launcher, preserve only explicitly allowed non-filesystem values needed by agent-owned authentication, parse only the supported output protocol of their backend, stream supported visible events, and return a normalized final response. The launcher must use an already installed backend runtime through a read-only bind rather than copying or reinstalling it, clear the inherited environment, replace home and XDG paths with sandbox paths, and expose only backend-specific authentication/state sources as controlled read-write mounts. Adapter tests must use fake executables or protocol fixtures and must not invoke installed subscriptions. Sandbox tests must independently verify runtime launch, workspace write access, read-only folder access, explicitly authorized folder writes, hidden unmounted paths, environment filtering, and fail-closed startup.

Every coding agent must live in its own folder, `src/coding-agents/agents/<name>/`, and be listed once in `src/coding-agents/registry.mjs`, whose order is the fixed report and `auto` fallback order. Modules outside `agents/` must read per-agent facts from the registry and must not name an agent; `tests/agent-boundaries.test.mjs` enforces this rule and rejects imports between agent folders, except the declared OMP dependency on the Pi protocol. Adding an agent requires its folder, one registry line, its entry in `tests/fixtures/sandbox-profiles.json`, updates to the tests that assert the fixed agent order, and documentation updates; `tests/add-agent.test.mjs` proves that no other source change is needed.

The descriptor `index.mjs` must call `defineAgent` and must import no process or adapter code, because the sandbox reads descriptors and adapters run on the sandbox. It declares `name`, `label`, `description`, `binary` (`env`, `installPaths(home)`), `capabilities` (`approvals`, `privateProc`), `state(env, home)` as `{source, target, login?}` entries whose `login` entry or else first entry holds the stored login, optional `homeEnvironment(root)`, `sandbox` (`envAllow`, `envSet`, `credentialEnv`, optional `installMarker`), `login` (`files`, `detect(directory)`), and a lazy `adapter()` import. `defineAgent` rejects an incomplete descriptor when the registry loads.

The adapter module must export `run(input)` and `listModels(input)` and may export `runLive(input)`, which the service prefers for explicit sessions and ask-for-approval executions. `run` receives `binary`, `prompt`, `workspace`, `hostWorkspace`, `sandbox`, `continuation`, `model`, `effort`, `websearch`, `permissionMode`, `permissionRequests`, `mcpServers`, `env`, `signal`, `onVisibleText`, `onSession`, and `setMessageHandler`, and resolves to `{outputText, continuation}`. The continuation is opaque to the service. A failure that leaves a resumable native session must carry it as `error.continuation`. `listModels` receives `binary`, `cwd`, `env`, `signal`, `sandbox`, and `details`; it resolves to model identifiers, or to `{id, label?, efforts, defaultEffort?}` records when `details` is true.

Persistent documentation, specifications, and comments must be written in English. A source change that alters behavior, interfaces, architecture, workflows, or constraints must update both explanatory HTML documentation and affected DS files. The overview must remain the introduction and definition for ALA, while the wiki must contain specialized terminology without an ALA entry. Documentation should link the first useful occurrence of a specialized term to its wiki entry, must not self-link a term inside its own definition, and must not repeat terminology links without additional navigational value.

The runtime supports Node.js 20 or newer and uses the built-in Node.js test runner. No formatter or linter contract is imposed beyond the module, file-size, line-length, and documentation rules in this specification.

## Conclusion

ALA code must remain modular, portable, testable without credentials, and free of runtime npm dependencies.
