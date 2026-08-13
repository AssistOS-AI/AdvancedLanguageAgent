# Advanced Language Agent

Advanced Language Agent (ALA) is a system-installed command-line interface for
language-oriented and documentation-oriented tasks. It gives people and other
agents one stable interface for using language models, authenticated agents,
research tools, and reusable task methods without integrating AchillesAgentLib
directly.

An **A-Skill** is a reusable AchillesAgentLib skill supplied by an independently
versioned task repository. It packages the instructions and optional code for one
coherent task. A-Skill is the task-facing role of an AchillesAgentLib skill in ALA,
not a separate skill format.

## Overview

A caller provides an instruction and may provide input through command arguments,
standard input, a URL, or a file. ALA selects a task and A-Skill, resolves the
skill's execution requirements against available backends, and writes the requested
result to standard output or a file. Diagnostics and routing information remain
separate from the result.

ALA owns generic execution infrastructure: direct, fast, and deep LLM execution;
authenticated coding-agent execution; multi-step agentic execution; web and
research access; temporary workspaces; routing; interactive sessions; verification;
and bounded retries. Task repositories own domain methods such as translation,
scientific-reference verification, controlled-language transformation, SOP Lang
planning, scientific writing, and web research.

## AchillesAgentLib and A-Skills

ALA uses AchillesAgentLib for skill discovery and execution, `MainAgent`-compatible
routing, model tags, `LLMAgent`, sessions, and supported execution regimes. An
A-Skill may use an AchillesAgentLib Code Skill (`cskill.md`), Orchestration Skill
(`oskill.md`), DBTable Skill (`tskill.md`), Dynamic Code Generation Skill
(`dcgskill.md`), or another compatible family.

Each task repository describes the requests it covers, selection evidence,
expected inputs and outputs, available A-Skills, constraints, verification
procedures, and the generic ALA capabilities its skills may request. Task
repositories are installed, configured, and versioned independently from ALA.

## Prerequisites

An ALA deployment requires a supported JavaScript runtime and resolvable access to
AchillesAgentLib. A task also requires a configured model provider or an
authenticated supported agent CLI that satisfies the selected A-Skill's execution
requirements. ALA invokes agent CLIs through their supported interfaces and does
not extract or reuse their credentials.

## Installation and configuration

Install ALA with the system package or application procedure supplied by its
distribution. Configure task-repository locations independently from the ALA
installation. Reuse AchillesAgentLib model configuration and semantic tags when
available. Manual runtime values may override environment-derived defaults.

The executable name, package manifest, concrete option syntax, configuration-file
schema, environment-variable schema, and exit codes belong to the distribution
contract. This repository does not invent values for those interfaces.

## Basic usage

ALA supports interactive and single-shot operation. A request contains an
instruction, an optional payload, and an optional explicit task or A-Skill
selection. Explicit selection bypasses automatic intent detection. Otherwise ALA
uses AchillesAgentLib/MainAgent-compatible selection, optionally preceded by
experimental symbolic detection that falls back whenever its evidence is uncertain.

Interactive sessions retain the selected task and previous result so corrective
feedback can constrain a bounded retry. A retry may use a stronger model or agentic
execution when the A-Skill's quality requirements justify escalation.

## Documentation

- [Technical documentation](docs/index.html)
- [Architecture and task repositories](docs/architecture.html)
- [Task and execution routing](docs/routing.html)
- [Execution backends and feedback](docs/execution.html)
- [Integration and evaluation](docs/integration.html)
- [Specification matrix](docs/specsLoader.html?spec=matrix.md)

## License

See [LICENSE](LICENSE).
