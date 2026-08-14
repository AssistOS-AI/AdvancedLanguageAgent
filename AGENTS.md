# Advanced Language Agent Agent Guidance

## Scope

This repository defines [Advanced Language Agent](docs/index.html) (ALA), a CLI that exposes generic language-task execution infrastructure. [AchillesAgentLib](docs/wiki.html#definition-achilles-agent-lib) is authorized as the library for skill discovery, `MainAgent`-compatible routing, `LLMAgent` execution, model selection, sessions, and supported agent backends. An [A-Skill](docs/wiki.html#definition-a-skill) is a reusable AchillesAgentLib skill supplied by an independently versioned [task repository](docs/wiki.html#definition-task-repository).

## Mandatory Reading Order

1. Read [README.md](README.md) for product scope, integration, and usage.
2. Read [docs/index.html](docs/index.html), the [command reference](docs/commands.html), and the relevant technical pages before changing documented behavior.
3. Read the canonical [terminology wiki](docs/wiki.html) and preserve its stable definition anchors.
4. Read [docs/specs/DS001-coding-style.md](docs/specs/DS001-coding-style.md) for coding style, module layout, file-size limits, and modular test organization.
5. Read affected specifications through [docs/specsLoader.html?spec=matrix.md](docs/specsLoader.html?spec=matrix.md). The DS specifications are the source of truth for requirements and constraints.
6. Run `detect-main-behaviors` before creating or changing `DS003-main-behavior.md` and whenever the product purpose, user outcome, essential interfaces, major hidden behavior, special project behavior, broad subsystems, architectural skeleton, or active product direction changes.

## Current Skill Catalog

ALA does not implement or distribute task-specific A-Skills in its core repository. The product [skill catalog](docs/wiki.html#definition-skill-catalog) is assembled from independently installed task repositories. ALA does distribute the generic `coding-agent` Code Skill as runtime infrastructure; it is registered only when Codex, OpenCode, or Pi is detected and is not a task-specific A-Skill. Update this section whenever the repository begins to implement or distribute an A-Skill as a product artifact. Internal repository tooling is not part of this catalog.

## Repository Rules

- Write all documentation, specifications, and comments in English.
- Keep DS numbering gap-free. Reserve `DS003-main-behavior.md` for the single Main Behavior specification and regenerate `docs/specs/matrix.md` from DS metadata.
- Every ordinary DS file must use `Introduction`, `Core Content`, and `Conclusion` as its only standard top-level content sections.
- Every ordinary DS file must contain exactly the `title` and `summary` frontmatter fields, with `title` equal to its filename stem. Derive the DS identifier from the filename and do not add status or owner metadata.
- Put requirements, rationale, assumptions, limitations, alternatives, and contract boundaries in declarative prose under `Core Content`; do not create a separate decision log.
- Treat `DS001-coding-style.md` as the canonical source for coding style, runtime layout, file-size rules, and test organization.
- Follow the persistent-documentation rules in `DS001-coding-style.md` for every documentation change.
- Keep every prose block on one logical source line in Markdown and HTML; allow the browser to wrap text naturally at the full-width container boundary.
- Keep `docs/wiki.html` as the canonical page for specialized terminology and remove page-local definition sections. Link the first useful occurrence of a term to its wiki anchor, do not link a term to its own wiki entry from inside that entry, and do not repeat a link without additional navigational value. Keep the product introduction and definition on `docs/index.html`, omit an ALA entry from the wiki, and point explanatory links on “ALA” or “Advanced Language Agent” to `docs/index.html`.
- Make every top-level header control a submenu button and place every documentation destination inside exactly one subject-based submenu. Direct top-level header links are prohibited.
- Keep `docs/commands.html` synchronized with every CLI command, option, input rule, output rule, configuration precedence rule, and exit code exposed by the implementation.
- Keep interactive slash commands synchronized with the CLI: `/agent list`, `/agent help`, `/agent auto <prompt>`, `/agent <codex|opencode|pi> <prompt>`, `/quit`, and `/exit` are local commands and must never be routed to an LLM.
- When source changes behavior, interfaces, architecture, workflows, or constraints, update both the HTML documentation and affected specifications.
- Keep imported A-Skills and their specifications in their owning task repositories or skill folders. A downstream consumer must not copy their DS files or standalone pages into the host project's `docs/` tree.

## Runtime Defaults

The executable is `ala`. User configuration resolves from `--config`, `ALA_CONFIG_PATH`, `$XDG_CONFIG_HOME/ala/config.json`, or `~/.config/ala/config.json`, in that order. Persistent task repositories are managed through `ala repo add`, `ala repo remove`, and `ala repo list`; `--task-repo` adds a repository for one invocation.

The default route uses AchillesAgentLib `MainAgent`. With no configured task repositories, `MainAgent` executes the general request without an A-Skill. When A-Skills are available, it may select one from the catalog. `--skill` takes precedence and executes the selected A-Skill directly. Experimental [symbolic routing](docs/wiki.html#definition-symbolic-routing) is enabled only through the interactive `/symbolic detection on|off` command, inspects only the instruction and A-Skill routing metadata, and must abstain or fall back when evidence is uncertain.

At process startup, ALA detects Codex, OpenCode, and Pi through their binary override variables, standard installation locations, and `PATH`. When at least one is available, ALA registers its generic `coding-agent` Code Skill with MainAgent. `--agent` forces this execution path, `ala agent list` reports detection, and the default priority is Codex, OpenCode, then Pi. Coding-agent execution must use only an ALA-owned temporary workspace, retain native continuation during an interactive session, and remove the workspace at shutdown.

All LLM interactions must use AchillesAgentLib's `LLMAgent` configured through runtime configuration and environment values. Manual configuration overrides must remain available. Routing-sensitive work must carry applicable metadata tags for documentation, specification, orchestration, bootstrap, and testing. Direct LLM execution is normal for straightforward work; stronger models, authenticated agents, research access, and temporary workspaces are selected when an A-Skill requests them and the environment provides them.

## Key Paths

- `package.json` — package identity, `ala` executable, scripts, and the AchillesAgentLib Git dependency.
- `bin/ala` — Bash entry point used when the repository's `bin/` directory is added to `PATH`.
- `bin/ala.mjs` — Node.js executable entry point used by the npm package mapping.
- `src/` — CLI, configuration, repository discovery, AchillesAgentLib loading, coding-agent adapters, and runtime modules.
- `tests/` — deterministic unit, contract, and CLI integration tests.
- `README.md` — user-facing overview, configuration, and usage.
- `docs/index.html` — technical documentation entry point.
- `docs/commands.html` — complete command and option reference.
- `docs/wiki.html` — canonical project terminology and stable definition anchors.
- `docs/specs/` — normative design specifications.
- `docs/specsLoader.html` — specification viewer.
- `scripts/generate_specs_matrix.mjs` — generated matrix builder.
- `scripts/verify_docs_links.mjs` — local documentation-link validator.
- `scripts/verify_static_site.js` — HTTP-level documentation validator.
- `fileSizesCheck.sh` — canonical file-size and long-line check.
- `ploinky-agent-lib` — installed package identity for the AchillesAgentLib Git dependency; public documentation and implementation must not hard-code a workstation path.
