---
title: DS006-workspaces-sessions-and-feedback
summary: Defines explicit cwd and home execution, temporary fallback workspaces, skill mounts, continuation, and cancellation.
---

## Introduction

ALA executes coding agents inside Bubblewrap and can either own a temporary task directory or operate on an explicit caller-owned working directory.

## Core Content

`--cwd <path>` must resolve to an existing directory. When supplied, ALA uses that directory as the host workspace, binds it read-write at `/workspace`, and never deletes it. When omitted, ALA lazily creates a private temporary workspace and removes it when the runtime closes. Arbitrary `--folder` and interactive `/folder` mounts are not part of the public contract.

`--home <path>` must resolve to an existing directory. ALA binds that complete explicit directory read-write at `/home/ala`, sets sandbox `HOME` to `/home/ala`, and sets Codex `CODEX_HOME` to `/home/ala/.codex`. This makes coding-agent configuration and authentication intentionally selectable by an embedding orchestrator. Without `--home`, ALA retains backend-specific controlled state mounts and an otherwise temporary sandbox home.

Every coding-agent and model-list process runs with Bubblewrap user, PID, IPC, and UTS isolation, shared network access, a private temporary directory, a private or empty process filesystem, a read-only root, read-only system and installed-runtime mounts, and a cleared allowlisted environment. Bubblewrap absence or required procfs failure stops execution without an unsandboxed fallback.

`--skillSets <comma-separated names>` restricts the active discovered catalog to those exact names. Selected skills are exposed read-only under `/workspace/.agents/skills/<name>`; ALA creates only required mount-point directories in an explicit cwd and does not remove unrelated project skills. An unknown requested name is a repository error.

`--MCPServers <comma-separated addresses>` accepts either `name=http://host:port/path` or plain `host:port` entries. ALA validates HTTP(S) URLs and unique safe names, then passes each server to Codex as a transient `mcp_servers.<name>.url` command-line configuration override. It does not modify the persistent Codex configuration under `--home`.

`--task <text>` supplies prompt text, while `--taskFile <path>` reads a detailed UTF-8 prompt before runtime construction. `--ca` selects `auto`, `codex`, `opencode`, or `pi`; `--agent` remains a compatibility spelling. `--model` is a coding-agent model hint when a coding agent is explicitly selected.

An interactive runtime retains MainAgent state, one selected backend, its native continuation, and workspace contents until exit. Interruption terminates the active child and preserves exit code `130`. A later process receives no implicit continuation, even when it uses the same explicit cwd and home.

## Conclusion

ALA now exposes the exact orchestration boundaries needed by RoboTeam while preserving fail-closed isolation and temporary-workspace behavior for standalone callers.
