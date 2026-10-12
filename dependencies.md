# Dependencies

The coding-agent effort change adds no third-party packages. Runtime prerequisites are Node.js 20 or newer, Linux Bubblewrap, and at least one installed coding-agent CLI. Tests use Node built-ins and fake protocol peers.

ALA has no runtime npm dependencies: `package.json` declares none, and every execution runs on an already installed native coding-agent CLI.

Effort support depends on the selected, already installed native CLI. Codex uses app-server `model/list` metadata and `turn/start.effort`, or the exec `model_reasoning_effort` config override. Pi uses RPC `get_available_models`, native `reasoning`/`thinkingLevelMap` metadata and `--thinking`; the existing 0.85.1-compatible version check remains in force for execution. OpenCode uses the authenticated `/provider` catalog and `prompt_async.variant`, on the existing 1.15.10-compatible server API. No upstream code was copied or modified. These optional dependencies cannot be replaced with built-ins while retaining their native sessions and accounts.

Protocol references are https://github.com/openai/codex, https://pi.dev/docs/latest/rpc, https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts, and https://github.com/anomalyco/opencode/tree/v1.15.10. Installed CLIs and their bundled license notices remain owned by their provisioning workflow. Exact installed revisions vary by environment and are not pinned by this change. Backend discovery, Bubblewrap admission, Pi version checks, and OpenCode server capability checks report missing or incompatible prerequisites; this feature does not install or upgrade executables. Upstream upgrades require rerunning adapter fixtures and native sandbox acceptance before release.
