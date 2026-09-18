# coding-agent

## Description

Delegate a bounded, multi-step language, research, planning, verification, transformation, or code-fragment task to an authenticated coding-agent CLI. Use this skill when direct model execution is insufficient and an installed agent can complete the work inside an isolated sandbox. Do not use it to take ownership of the caller's repository.

## Input Format

Plain-text instructions and any payload content required to complete the task.

## Output Format

The coding agent's final response as plain text.

## Constraints

Execution is restricted to ALA's Bubblewrap namespace. ALA mounts only what the caller supplies: the writable `--cwd` and each `--folder` at its original absolute path, or under a caller-chosen alias. Unmounted host paths are intentionally unavailable. ALA does not create, discover, or overlay task skills. The selected agent must already be installed and authenticated through its own supported CLI home.
