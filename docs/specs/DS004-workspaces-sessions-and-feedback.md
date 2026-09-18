---
title: DS004-workspaces-sessions-and-feedback
summary: Defines explicit cwd and folder mounts, home execution, retained temporary workspaces, continuation, and cancellation.
---

## Introduction

ALA executes coding agents inside Bubblewrap and mounts exactly the directories the caller supplies. It never discovers, copies, mounts or overlays task skills.

## Core Content

`--cwd <path> [as <alias>]` supplies the writable working directory. Without an alias the source is mounted read-write at its canonical absolute path and the coding agent runs there. With an alias the source is mounted read-write at `/workspace/<alias>` and that path becomes the agent working directory. When `--cwd` is omitted, ALA lazily creates a private temporary directory, mounts it read-write at its canonical path, and retains it when the runtime closes so the execution can be inspected afterwards. ALA never deletes a caller-supplied or temporary working directory.

`--folder <path> [write] [as <alias>]` mounts an existing directory. Without `write` the mount is read-only; `write` makes it read-write. Without an alias the source is mounted at its canonical absolute path; an alias mounts the same source at `/workspace/<alias>`. Sources are canonicalized, reserved sandbox destinations (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/proc`, `/dev`, `/etc`, `/home/ala`) are rejected, symlinked sources resolve to their canonical target, and overlapping or duplicate destinations fail visibly. A folder may be a read-only ancestor of the writable working directory; ancestors are mounted before descendants so a parent mount cannot hide the writable child. Every backend execution and model-list process must receive the same mounts. ALA must not interpret mounted configuration, load caller SDKs or implement caller event protocols. Unix sockets remain caller-owned endpoints accessible according to their permissions; the host owns their lifecycle.

Codex app-server progress must publish complete intermediate assistant messages and completed command output, never individual transport deltas or final-answer text. Explicit commentary is published when its item completes. When the native protocol omits the message phase, the last completed assistant message is reserved for the final result until subsequent work proves it intermediate. A direct final answer produces no progress messages. Consumers must not interpret transport fragments as execution steps.

Successful Bubblewrap probes must be cached by executable and complete probe arguments. An outer-capability procfs success must never certify the user-namespace path on a subsequent check; repeated checks must preserve the correct construction mode.

`--home <path>` must resolve to an existing directory. ALA binds that complete explicit directory read-write at `/home/ala`, sets sandbox `HOME` to `/home/ala`, and sets Codex `CODEX_HOME` to `/home/ala/.codex`. This makes coding-agent configuration and authentication intentionally selectable by an embedding orchestrator. Without `--home`, ALA retains backend-specific controlled state mounts and an otherwise temporary sandbox home.

Every coding-agent and model-list process runs with Bubblewrap user, PID, IPC, and UTS isolation, shared network access, a private temporary directory, a private or empty process filesystem, a read-only root, read-only system and installed-runtime mounts, and a cleared allowlisted environment. Bubblewrap absence or required procfs failure stops execution without an unsandboxed fallback.

ALA must make the Node runtime available read-only for backend executables and helper scripts even when the backend itself is a standalone native binary. Prefix-installed Node packages must retain access to package metadata and sibling dependencies without exposing unrelated host files.

`--MCPServers <comma-separated addresses>` accepts either `name=http://host:port/path` or plain `host:port` entries. ALA validates HTTP(S) URLs and unique safe names, then passes each server to Codex as a transient `mcp_servers.<name>.url` command-line configuration override. It does not modify the persistent Codex configuration under `--home`.

`--task <text>` supplies prompt text, while `--taskFile <path>` reads a detailed UTF-8 prompt before runtime construction. `--ca` selects `auto`, `codex`, `opencode`, or `pi`; `--agent` remains a compatibility spelling. `--model` is a coding-agent model hint when a coding agent is explicitly selected.

An interactive runtime retains MainAgent state, one selected backend, its native continuation, and workspace contents until exit. Interruption terminates the active child and preserves exit code `130`. A later process receives no implicit continuation from cwd or home. Explicit --session-id and --resume-session bind the next execution to the saved native conversation and pinned backend.

Persistent coding-agent sessions use a caller-supplied UUID through `--session-id` with explicit `--ca`, `--home`, and `--cwd`. The private `<home>/.ala/sessions/<uuid>.json` record stores the selected backend and its native continuation, never prompt/result transcripts. An exclusive process lock prevents concurrent writers. `--resume-session` must require the record and native continuation and preserve home, workspace, and backend. Codex native identity is saved after turn/start accepts the first turn, before execution completion. A thread/start ID alone is provisional and must not be published as resumable state. Other backends save their persistent identity as soon as available, so cancellation does not depend on final stdout. Codex uses app-server threads and turns; Pi uses its RPC session file; OpenCode creates or reads the exact native session through its owned authenticated server.

`--control-stdin` reserves stdin for bounded JSONL message commands while stdout remains the final result. Persistent mode emits session-ready and correlated message receipts through the structured stderr event stream. Native steering must be acknowledged before reporting delivered. Unsupported or not-yet-ready delivery queues a follow-up in the same runtime, never a concurrent invocation. Stop cancels the active operation; queued follow-ups are execution-local and do not survive interruption or process loss. Missing native state must fail rather than silently start a new conversation.

`--permissions ask-for-approval|full-access` must select the native coding-agent policy for the next execution; omission retains `full-access`. Full access remains confined by Bubblewrap. An invalid value is a usage error. Pi with ask-for-approval must fail before native conversation creation with an actionable instruction to select full-access or Codex/OpenCode; selection must not silently change the backend or policy.

A reply-capable embedding host receives `{type:'coding-agent-request',id,agent,kind:'permission',method,title,message,detail,options:[{id,label,description}]}` through the event stream. The request ID must be an opaque process-local UUID distinct from native request IDs. Native payloads and answer values remain owned by the adapter. The host must reply through control stdin with `{type:'interaction-response',id,optionId}` or `{type:'interaction-response',id,cancelled:true}`. Replies must be dispatched while execution waits, never queued as conversation messages. Invalid, duplicate, stale, and unadvertised answers must produce diagnostics without answering another request.

Every completed request emits `{type:'coding-agent-request-resolved',id,reason}` with reason `answered`, `cancelled`, `expired`, or `backend-resolved`. Cancellation, control EOF, and backend failure must clear outstanding requests and cancel the owned operation. Without a reply-capable host, native approval requests must be declined visibly rather than auto-approved or left waiting. Native requests must be classified before outgoing response correlation, retain string or integer native IDs, and never inherit outgoing command timeouts. Unknown non-permission methods must fail explicitly. ALA must not maintain a remembered-approval cache or promise native grants survive a new backend process.

Interactive `/permissions` must report the requested native policy, initialized from `--permissions` or `full-access`. `/permissions ask-for-approval|full-access` must update only subsequent coding-agent executions in the existing runtime, without resetting workspace, pinned backend or native continuation and without persisting configuration. Invalid input must leave the prior value unchanged. Changing policy must not create an approval-response channel; absent a reply-capable host, operations requiring approval remain declined. Pi's unsupported-policy rejection remains authoritative.

## Conclusion

ALA exposes explicit working directories, configuration homes, and resumable conversations while preserving fail-closed isolation and retained-workspace behavior for callers that rely on ALA's temporary directory.
