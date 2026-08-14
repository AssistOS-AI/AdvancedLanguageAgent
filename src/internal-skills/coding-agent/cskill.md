# coding-agent

## Description

Delegate a bounded, multi-step language, research, planning, verification, transformation, or code-fragment task to an authenticated coding-agent CLI. Use this skill when direct model execution is insufficient and an installed agent can complete the work inside an isolated temporary workspace. Do not use it to take ownership of the caller's repository.

## Input Format

Plain-text instructions and any payload content required to complete the task.

## Output Format

The coding agent's final response as plain text.

## Constraints

Execution is restricted to ALA's temporary task workspace. The selected agent must already be installed and authenticated through its own supported CLI.
