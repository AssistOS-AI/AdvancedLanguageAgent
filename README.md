# Advanced Language Agent

Advanced Language Agent (ALA) is a system-installed command-line interface for
language and documentation work. It gives people and other agents one stable entry
point for prompts, research, transformations, planning, and verification.

ALA uses AchillesAgentLib, a JavaScript library that discovers and runs reusable
agent skills. ALA performs task-specific work through A-Skills. An A-Skill is a
reusable AchillesAgentLib skill installed through an independent task repository.
It packages the instructions and optional code for one kind of work.

## Overview

ALA accepts an instruction and optional input from command-line arguments, standard
input, a URL, or a file. It selects an A-Skill, determines whether that skill needs
a language model, coding agent, web research, or temporary workspace, and writes the
requested result to standard output or a file. Diagnostics and routing information
stay separate from the result stream.

Within AchillesAgentLib, `MainAgent` coordinates skill discovery and routing. ALA
also reuses the library's model tags, language-model agents, sessions, and agent
backends. Task repositories are installed and configured independently from the ALA
runtime.

## AchillesAgentLib skill families

AchillesAgentLib provides several skill families for different execution needs.
Code Skills (`cskill.md`) run modules supplied by a task repository. Orchestration
Skills (`oskill.md`) coordinate multiple skills, tools, or agents. DBTable Skills
(`tskill.md`) describe table fields and database operations. Dynamic Code Generation
Skills (`dcgskill.md`) generate and execute code during a task.

## Prerequisites

ALA requires a JavaScript runtime supported by its deployment and access to
AchillesAgentLib. Execution requires either a configured model provider or an
authenticated coding-agent CLI, depending on the selected A-Skill and available
backend.

## Installation and configuration

Install ALA through the deployment's system package or application installation
procedure, then configure task repositories independently from the ALA installation.
Existing AchillesAgentLib model configuration and semantic tags are reused when
available. See
[DS005](docs/specsLoader.html?spec=DS005-integration-and-evaluation.md) for the
integration contract.

## Basic usage

ALA supports interactive and single-shot operation. It accepts instructions and
optional payloads through arguments, standard input, URLs, or files, and supports
explicit task or A-Skill selection. Results are written to standard output or files
while diagnostics and routing information remain separate.

## Documentation

- [ALA documentation](docs/index.html)
- [Specification matrix](docs/specsLoader.html?spec=matrix.md)

## License

See [LICENSE](LICENSE).
