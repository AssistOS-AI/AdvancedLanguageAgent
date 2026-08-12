# Advanced Language Agent Agent Guidance

## Scope

This repository defines Advanced Language Agent (ALA), a CLI that exposes generic
language-task execution infrastructure. AchillesAgentLib is the skill-based agent
library used for discovery and execution. An A-Skill is a reusable AchillesAgentLib
skill supplied by an independently versioned task repository. It packages the
instructions and optional code for one task. Code Skills run modules, Orchestration
Skills coordinate multiple actions, DBTable Skills describe table operations, and
Dynamic Code Generation Skills produce code during execution. ALA depends on AchillesAgentLib for skill discovery,
`MainAgent`-coordinated routing, model selection, sessions, and compatible agent
backends.

## Mandatory Reading Order

1. Read [README.md](README.md) for project scope, integration, and usage.
2. Read [docs/index.html](docs/index.html) and the relevant technical pages before changing documentation-related behavior.
3. Read [docs/specs/DS001-coding-style.md](docs/specs/DS001-coding-style.md) for coding style, module layout, file-size limits, and modular tests.
4. Read the affected specifications through [docs/specsLoader.html?spec=matrix.md](docs/specsLoader.html?spec=matrix.md). The DS specifications are the source of truth for requirements and constraints.

## Repository Rules

- Write all documentation, specifications, and comments in English.
- Keep DS numbering gap-free and regenerate `docs/specs/matrix.md` from DS metadata.
- Every ordinary DS file must contain `Introduction`, `Core Content`, `Decisions & Questions`, and `Conclusion`; questions use numbered subchapters.
- `DS001-coding-style.md` is the canonical source for coding style and test organization.
- When source code changes behavior, interfaces, architecture, workflows, or constraints, update both HTML documentation and the affected specifications.
- Imported A-Skills belong in their own task repositories or skill folders.
  Downstream consumer projects must not copy their DS files or standalone skill
  pages into the host project's `docs/` tree.

## Runtime Defaults

The default routing path is AchillesAgentLib/MainAgent-compatible intent and skill
selection. Experimental symbolic routing is opt-in and must abstain or fall back
when evidence is uncertain. Explicit task or A-Skill selection takes precedence
over automatic selection. Direct LLM execution is the normal path for
straightforward work; stronger models, coding agents, research access, and
temporary workspaces are selected when an A-Skill requests them and the environment
provides them.

## Key Paths

- `README.md` — user-facing project overview, integration, and usage.
- `docs/index.html` — documentation entry point.
- `docs/specs/` — normative design specifications.
- `docs/specsLoader.html` — specification viewer.
- `AchillesAgentLib` — conceptual external dependency; do not hard-code a workstation path in implementation or public documentation.
