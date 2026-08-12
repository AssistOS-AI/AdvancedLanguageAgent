# Advanced Language Agent Agent Guidance

## Scope

This repository documents and will implement Advanced Language Agent (ALA), a CLI that exposes generic language-task execution infrastructure. “A-Skill” means an Achilles skill: a task-specific skill supplied by an independently versioned task repository. The design depends on AchillesAgentLib for skill discovery, `MainAgent` routing, model mediation, sessions, and compatible agent backends.

## Mandatory Reading Order

1. Read [README.md](README.md) for project scope, integration, and usage.
2. Read [docs/index.html](docs/index.html) and the relevant technical pages before changing documentation-related behavior.
3. Read [docs/specs/DS001-coding-style.md](docs/specs/DS001-coding-style.md) for coding style, module layout, file-size limits, and modular tests.
4. Read the affected specifications through [docs/specsLoader.html?spec=matrix.md](docs/specsLoader.html?spec=matrix.md). The DS specifications are the source of truth for requirements and constraints.

## Current Skill Catalog

The repository uses the `gamp-specs` skill under `.agents/skills/gamp-specs/` to govern this documentation set. A-Skills are supplied by independently versioned task repositories. Update this section whenever skill folders are added or removed.

## Repository Rules

- Write all documentation, specifications, and comments in English.
- Keep DS numbering gap-free and regenerate `docs/specs/matrix.md` from DS metadata.
- Every ordinary DS file must contain `Introduction`, `Core Content`, `Decisions & Questions`, and `Conclusion`; questions use numbered subchapters.
- `DS001-coding-style.md` is the canonical source for coding style and test organization.
- When source code changes behavior, interfaces, architecture, workflows, or constraints, update both HTML documentation and the affected specifications.
- Follow `.agents/skills/gamp-specs/references/documentation-writing-guidelines.md` for persistent documentation.
- Imported A-Skills belong in their own task repositories or skill folders. Downstream consumer projects must not copy their DS files or standalone skill pages into the host project's `docs/` tree.
- Update this GAMP skill guidance when new skill families, coding-style rules, or bootstrap rules are introduced.

## Runtime Defaults

The default routing path is AchillesAgentLib/MainAgent-compatible intent and skill selection. Experimental symbolic routing is opt-in and must abstain or fall back when evidence is uncertain. Explicit task or A-Skill selection takes precedence over automatic selection. Direct LLM execution is the normal path for straightforward work; stronger models, coding agents, research access, and temporary workspaces are selected when an A-Skill requests them and the environment provides them.

## Key Paths

- `README.md` — user onboarding and verified repository state.
- `docs/index.html` — documentation entry point.
- `docs/specs/` — normative design specifications.
- `docs/specsLoader.html` — specification viewer.
- `.agents/skills/gamp-specs/` — active documentation skill and its references/scripts.
- `AchillesAgentLib` — conceptual external dependency; do not hard-code a workstation path in implementation or public documentation.
