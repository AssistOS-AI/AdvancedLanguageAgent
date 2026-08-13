# Advanced Language Agent Agent Guidance

## Scope

This repository defines Advanced Language Agent (ALA), a CLI that exposes generic
language-task execution infrastructure. AchillesAgentLib is authorized as the
library for skill discovery, `MainAgent`-compatible routing, `LLMAgent` execution,
model selection, sessions, and supported agent backends. An A-Skill is a reusable
AchillesAgentLib skill supplied by an independently versioned task repository.

## Mandatory Reading Order

1. Read [README.md](README.md) for product scope, integration, and usage.
2. Read [docs/index.html](docs/index.html) and the relevant technical pages before
   changing documented behavior.
3. Read [docs/specs/DS001-coding-style.md](docs/specs/DS001-coding-style.md) for
   coding style, module layout, file-size limits, and modular test organization.
4. Read affected specifications through
   [docs/specsLoader.html?spec=matrix.md](docs/specsLoader.html?spec=matrix.md).
   The DS specifications are the source of truth for requirements and constraints.
5. Run `detect-main-behaviors` before creating or changing
   `DS003-main-behavior.md` and whenever the product purpose, essential interfaces,
   broad subsystems, architectural skeleton, or active product direction changes.

## Current Skill Catalog

ALA does not implement or distribute task-specific A-Skills in its core repository.
The product skill catalog is assembled from independently installed task
repositories. Update this section whenever the repository begins to implement or
distribute an A-Skill as a product artifact. Internal repository tooling is not
part of this catalog.

## Repository Rules

- Write all documentation, specifications, and comments in English.
- Keep DS numbering gap-free. Reserve `DS003-main-behavior.md` for the single Main
  Behavior specification and regenerate `docs/specs/matrix.md` from DS metadata.
- Every ordinary DS file must use `Introduction`, `Core Content`, and `Conclusion`
  as its only standard top-level content sections.
- Put requirements, rationale, assumptions, limitations, alternatives, and contract
  boundaries in declarative prose under `Core Content`; do not create a separate
  decision log.
- Treat `DS001-coding-style.md` as the canonical source for coding style, runtime
  layout, file-size rules, and test organization.
- Follow the persistent-documentation rules in `DS001-coding-style.md` for every
  documentation change.
- When source changes behavior, interfaces, architecture, workflows, or constraints,
  update both the HTML documentation and affected specifications.
- Keep imported A-Skills and their specifications in their owning task repositories
  or skill folders. A downstream consumer must not copy their DS files or standalone
  pages into the host project's `docs/` tree.

## Runtime Defaults

The default route uses AchillesAgentLib/MainAgent-compatible task and A-Skill
selection. Explicit selection takes precedence. Experimental symbolic routing is
opt-in and must abstain or fall back when evidence is uncertain.

All LLM interactions must use AchillesAgentLib's `LLMAgent` configured through
runtime configuration and environment values. Manual configuration overrides must
remain available. Routing-sensitive work must carry applicable metadata tags for
documentation, specification, orchestration, bootstrap, and testing. Direct LLM
execution is normal for straightforward work; stronger models, authenticated
agents, research access, and temporary workspaces are selected when an A-Skill
requests them and the environment provides them.

## Key Paths

- `README.md` — user-facing overview, configuration, and usage.
- `docs/index.html` — technical documentation entry point.
- `docs/specs/` — normative design specifications.
- `docs/specsLoader.html` — specification viewer.
- `scripts/generate_specs_matrix.mjs` — generated matrix builder.
- `scripts/verify_docs_links.mjs` — local documentation-link validator.
- `scripts/verify_static_site.js` — HTTP-level documentation validator.
- `fileSizesCheck.sh` — canonical file-size and long-line check.
- `AchillesAgentLib` — conceptual external dependency; public documentation and
  implementation must not hard-code a workstation path.
