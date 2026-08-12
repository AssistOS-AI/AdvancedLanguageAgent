# Advanced Language Agent

Advanced Language Agent (ALA) is a system-installed command-line interface for language and documentation work. It gives people and other agents one stable entry point for prompts, research, transformations, planning, and verification while independent task repositories provide task-specific A-Skills (Achilles skills).

## Overview

ALA accepts an instruction and optional input from command-line arguments, standard input, a URL, or a file. It selects a task repository or A-Skill, resolves the generic execution capabilities that skill requests, and writes the requested result to standard output or a file. Diagnostics and routing information stay separate from the result stream.

ALA reuses AchillesAgentLib, especially its `MainAgent` discovery and routing behavior, model tags, LLM agents, sessions, and agent backends. Task repositories are installed and configured independently from the ALA runtime.

## Prerequisites

ALA requires a JavaScript runtime supported by its deployment and access to AchillesAgentLib. Execution requires either a configured model provider or an authenticated coding-agent CLI, depending on the selected A-Skill and available backend.

## Installation and configuration

Install ALA through the deployment's system package or application installation procedure, then configure task repositories independently from the ALA installation. Existing AchillesAgentLib model configuration and semantic tags are reused when available. See [DS005](docs/specsLoader.html?spec=DS005-integration-and-evaluation.md) for the integration contract.

## Basic usage

ALA supports interactive and single-shot operation. It accepts instructions and optional payloads through arguments, standard input, URLs, or files, and supports explicit task or A-Skill selection. Results are written to standard output or files while diagnostics and routing information remain separate.

## Documentation

- [ALA documentation](docs/index.html)
- [Specification matrix](docs/specsLoader.html?spec=matrix.md)
- [Agent guidance](AGENTS.md)

## License

See [LICENSE](LICENSE).
