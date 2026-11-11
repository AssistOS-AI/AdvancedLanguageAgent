# Dependencies

The coding-agent effort change adds no third-party packages. Runtime prerequisites are Node.js 20 or newer, a sandbox launcher (Linux Bubblewrap, or `/usr/bin/sandbox-exec` on macOS), and at least one installed coding-agent CLI. Tests use Node built-ins and fake protocol peers.

ALA has no runtime npm dependencies: `package.json` declares none, and every execution runs on an already installed native coding-agent CLI.

On macOS the sandbox uses only programs of the operating system, and ALA installs and downloads none of them. `sandbox-exec` is deprecated by Apple and its profile language is undocumented, so a macOS update can change behavior; the pinned profile fixture, the live tests, the start probe and the escape gate in DS006 detect such a change.

| Program | Used for |
| --- | --- |
| `/usr/bin/sandbox-exec` | Applies the Seatbelt profile to every agent and model-catalog process; ALA fails closed without it |
| `/usr/bin/perl` | Runs the reader of the start probe; ALA fails closed without it |
| `/bin/ps` | Reads the process start identity for session locks |
| `/bin/rm`, `/bin/chmod`, `/usr/bin/chflags` | Remove a private folder inside a confined helper |
| `/bin/launchctl` | Used only by the opt-in gate `scripts/seatbelt-escape-gate.mjs` |

The live macOS tests also start system programs such as `/usr/bin/python3`.

Effort support depends on the selected, already installed native CLI. Codex uses app-server `model/list` metadata and `turn/start.effort`, or the exec `model_reasoning_effort` config override. Pi uses RPC `get_available_models`, native `reasoning`/`thinkingLevelMap` metadata and `--thinking`; the existing 0.85.1-compatible version check remains in force for execution. OpenCode uses the authenticated `/provider` catalog and `prompt_async.variant`, on the existing 1.15.10-compatible server API. No upstream code was copied or modified. These optional dependencies cannot be replaced with built-ins while retaining their native sessions and accounts.

Protocol references are https://github.com/openai/codex, https://pi.dev/docs/latest/rpc, https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts, and https://github.com/anomalyco/opencode/tree/v1.15.10. Installed CLIs and their bundled license notices remain owned by their provisioning workflow. Exact installed revisions vary by environment and are not pinned by this change. Backend discovery, Bubblewrap admission, the Seatbelt start probe, Pi version checks, and OpenCode server capability checks report missing or incompatible prerequisites; this feature does not install or upgrade executables. Upstream upgrades require rerunning adapter fixtures and native sandbox acceptance before release.
