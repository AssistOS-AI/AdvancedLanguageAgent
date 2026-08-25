# coding-agent

## Description

Delegate a bounded, multi-step language, research, planning, verification, transformation, or code-fragment task to an authenticated coding-agent CLI. Use this skill when direct model execution is insufficient and an installed agent can complete the work inside an isolated temporary workspace. Do not use it to take ownership of the caller's repository.

## Input Format

Plain-text instructions and any payload content required to complete the task.

## Output Format

The coding agent's final response as plain text.

## Constraints

Execution is restricted to ALA's Bubblewrap namespace with the temporary task workspace at `/workspace`. Task skills under `/workspace/.agents/skills` are strict read-only mounts. When `/workspace/.ala/folders.json` lists caller-authorized folders, inspect only their sandbox paths and respect each `read-only` or `read-write` access mode. Unmounted host paths are intentionally unavailable. The selected agent must already be installed and authenticated through its own supported CLI.
