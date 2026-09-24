# Advanced Language Agent

[Advanced Language Agent](docs/index.html) (ALA) is a command-line application for language and documentation tasks. It executes general requests through AchillesAgentLib and delegates bounded work to an installed coding agent. ALA mounts exactly the directories the caller supplies through `--cwd` and `--folder`; it does not discover, create, mount or overlay task skills. ALA writes the result to standard output or a file.

## Install

ALA requires Node.js 20 or newer, npm, and Git. Coding-agent execution additionally requires Linux with Bubblewrap (`bwrap`); ALA fails closed instead of starting Codex, OpenCode, or Pi without it. Coding-agent CLIs remain installed once in their normal system or user locations: ALA never reinstalls or copies them. It resolves each launcher to its existing runtime prefix, mounts that prefix read-only, and prefers its matching executable path inside the sandbox. Prefixes below the mounted working directory use a private runtime path so the workspace mount cannot hide the installed executable; other prefixes retain their existing paths. An external target of `/etc/resolv.conf` is mounted read-only when systemd-resolved stores it under `/run`. Codex and OpenCode also require Bubblewrap to mount a private procfs; ALA never substitutes the caller's `/proc`. It first uses a private user namespace. In a capability-bounded nested container where that extra user namespace cannot mount procfs, ALA may use the outer sandbox capability to construct the PID namespace and private procfs, then drops all capabilities before starting the coding agent. Codex is told not to construct a second native sandbox: its `danger-full-access` setting is scoped inside ALA's Bubblewrap boundary, where only the mounted directories and controlled home remain writable. Direct MainAgent execution remains available without a coding agent. From the repository root, run:

```sh
npm install
```

This installs AchillesAgentLib from the Git dependency in `package.json`.

Add the project's `bin` directory to `PATH`. Put this line in `~/.bashrc` when the repository is located at `$HOME/Desktop/work/AdvancedLanguageAgent`:

```sh
export PATH="$PATH:$HOME/Desktop/work/AdvancedLanguageAgent/bin"
```

Reload the shell configuration and verify the installation:

```sh
source ~/.bashrc
ala --version
ala --help
```

## Configure

ALA can use [Soul Gateway](docs/wiki.html#definition-soul-gateway) or your own AchillesAgentLib-compatible model configuration.

To use Soul Gateway, create a `.env` file in the directory where you run ALA or in one of its parent directories:

```dotenv
SOUL_GATEWAY_BASE_URL=https://your-soul-gateway.example
SOUL_GATEWAY_API_KEY=your-api-key
```

AchillesAgentLib loads the first `.env` file it finds while walking upward from the current working directory. With the bundled model configuration, ALA uses the Soul Gateway `plan` model by default.

To configure your own models, point ALA to another AchillesAgentLib model configuration:

```sh
export LLM_MODELS_CONFIG_PATH=/absolute/path/to/LLMConfig.json
```

Select a configured model for one invocation with `--model`, or set `ALA_MODEL` as the default:

```sh
ala --model fast "Summarize this text" --file report.md
export ALA_MODEL=fast
```

User configuration lives in `$HOME/.ala/config.json`. Set `ALA_CONFIG_PATH` to another root directory when an embedding application needs isolated ALA state; ALA then uses `<ALA_CONFIG_PATH>/.ala/config.json`. The explicit `--config <file>` option remains available for a one-command file override. Legacy `taskRepositories` fields in existing files are ignored.

ALA does not store prompt or result transcripts itself. Coding agents own their native conversation history. Embedding applications can resume a native conversation through explicit session options and consume the structured event stream for visible logs.

ALA also detects authenticated Codex, OpenCode, and Pi installations. Inspect the detected backend names with:

```sh
ala agent list
```

## Run a single task

A single-task command runs in one-shot mode. Without `--cwd`, ALA creates a temporary working directory and retains it after the command finishes. With `--cwd`, it uses the existing directory directly and never deletes it. Reusing cwd alone does not resume a conversation.

Run a general request:

```sh
ala "Summarize the supplied report" --file report.md
```

Write the result to a file:

```sh
ala "Summarize this report" --file report.md --output summary.md
```

MainAgent may delegate suitable complex work to an installed [coding agent](docs/wiki.html#definition-coding-agent) automatically. Force one supported backend with `--ca`; `auto` uses the configured priority, which defaults to Codex, OpenCode, then Pi. `--agent` remains a compatibility alias:

```sh
ala --ca codex "Research this topic and produce a verified summary"
ala --ca auto "Plan and validate this multi-step language task"
```

The selected coding-agent CLI must already be authenticated through its own login mechanism. By default ALA passes no model option, so each selected CLI uses its own default model. In an interactive session, `/agent <codex|opencode|pi> models` asks that backend for its available model identifiers, `/agent <codex|opencode|pi> model <model-name>` persists a backend-specific selection, and `/agent <codex|opencode|pi> model default` removes that override so the agent CLI chooses its default again. ALA applies each change to every subsequent invocation. ALA's `--model`, `--tag`, `--reasoning-effort`, and `--model-config` settings continue to apply only to direct LLMAgent execution and do not override coding-agent model selection. ALA runs every agent and model-catalog process inside Bubblewrap, clears inherited environment variables before restoring a backend-specific allowlist, mounts the caller's `--cwd` and `--folder` directories at their canonical or aliased paths, exposes the existing backend runtime read-only, exposes only controlled authentication/state directories read-write, and retains the temporary directory it created when `--cwd` is omitted.

Embedding applications can select a persistent coding-agent home, an existing work tree, extra directories, a prompt file, and Streamable HTTP MCP servers explicitly:

```sh
ala --home /robot/home --cwd /project --folder /shared --folder /scratch write \
  --taskFile task.prompt --MCPServers desktop=http://127.0.0.1:48100/mcp --ca codex
```

`--home` is bound as the sandbox home and supplies saved agent authentication and configuration. `--cwd <path> [as <alias>]` is the writable working directory, mounted at its canonical path or under `/workspace/<alias>`. `--folder <path> [write] [as <alias>]` mounts extra directories read-only unless marked `write`. `--task` or `--taskFile` supplies the prompt, and `--MCPServers` injects temporary URL configuration into the selected coding agent (Codex or OpenCode) without rewriting its saved config. Interactive folder mounts are not supported.

Coding-agent web search is off by default. Use bare `--websearch` to enable it for one invocation, `--websearch on|off` as an explicit invocation-only override, or persist the setting during an interactive session:

```bash
ala --websearch --agent codex "Find current sources and summarize them"
ala --interactive
/websearch on
/websearch off
```

The interactive command saves `codingAgents.websearch` in the selected ALA configuration and applies it immediately without resetting the current coding-agent session. ALA maps the setting to Codex live search and OpenCode web search and fetch permissions. Pi has no ALA-managed web-search capability, so the setting does not change Pi arguments or tools. Authentication, provider quotas, site terms, and rate limits remain owned by the selected backend and its search provider.

## Continue a coding-agent task

Use a new UUID to create a persistent session. Later invocations require the same home, cwd, session id, and coding backend. `--ca auto` selects a backend once and then keeps that choice.

```sh
ala --home /robot/home --cwd /project --ca codex \
  --session-id 11111111-1111-4111-8111-111111111111 --task "Inspect the project"
ala --home /robot/home --cwd /project --ca codex \
  --session-id 11111111-1111-4111-8111-111111111111 --resume-session --task "Add tests"
```

ALA saves the backend and native session reference under `<home>/.ala/sessions`. Stop interrupts execution without deleting that reference. Missing native state fails explicitly rather than starting an unrelated conversation.

An embedding process can add `--control-stdin` and send JSONL messages such as `{"type":"message","id":"request-1","message":"Also check the tests"}`. Codex app-server and Pi RPC support live steering. The current OpenCode adapter queues follow-ups until the active invocation finishes. Structured stderr receipts distinguish `delivered` from `queued`; stdout remains the final response. Pending messages are execution-local and are cancelled on Stop. See the [session command reference](docs/commands.html) for the protocol.

Select native permission policy with `--permissions ask-for-approval|full-access`; the standalone default is full-access inside Bubblewrap. An embedding host must attach control stdin to display and answer native approval requests. Codex uses native app-server approval decisions; OpenCode uses its authenticated native server and once/always/reject replies, without changing project `opencode.json`. Pi supports full-access only and requires version 0.85.1 or a verified compatible RPC release. An older installation must be upgraded separately or selected through `PI_BIN`; ALA does not modify global installations. Missing reply capability declines an operation requiring approval rather than granting access. Native remembered grants are not an ALA authorization cache and need not survive a new native process.

## Run interactively

Start an interactive session:

```sh
ala
```

Unlike one-shot execution, this process retains one ALA runtime across prompts. MainAgent conversation state remains available, the working directory is reused after its first creation, and the first coding backend used by the session is pinned with its native continuation until the session exits.

Interactive sessions also accept local slash commands. `/agent ...` commands are handled by ALA and are never sent to the LLM:

```text
/help
/agent list
/agent codex models
/agent codex model gpt-5.6-sol
/agent codex model default
/agent codex Review this task
/agent auto Produce a verified multi-step summary
/permissions
/permissions ask-for-approval
/permissions full-access
/websearch on
/websearch off
/quit
```

`/help` lists every interactive command. `/agent` commands discover a backend, inspect or select its native model, and delegate prompts; `/websearch on|off` controls supported search tools. While a terminal waits, ALA renders a transient thinking indicator and supported live backend events on standard error, leaving the normalized final result on standard output. Enter `/quit`, `/exit`, `:quit`, or `:exit` to close the session.

`/permissions` reports the requested native policy. Supplying `ask-for-approval` or `full-access` changes subsequent executions in this interactive session without resetting the native conversation or saving configuration. The initial policy comes from `--permissions`, defaulting to `full-access`. Pi rejects ask-for-approval. The command does not add a reply channel: without a reply-capable embedding host, native operations requiring approval are declined.

Expose a caller-owned directory with `--folder /absolute/path as runtime`. It appears read-only at `/workspace/runtime`; without `as`, it appears at the original absolute path. Repeat `--folder` for separate destinations, and add `write` to make one writable. ALA only validates and mounts directories; the caller prepares dependencies and owns any socket protocol and cleanup.

## More information

See the [command reference](docs/commands.html) for every CLI command and option, the [technical documentation](docs/index.html) for architecture, the [wiki](docs/wiki.html) for canonical terminology, and the [specification matrix](docs/specsLoader.html?spec=matrix.md) for complete runtime contracts.

## Development

```sh
npm test
npm run check
npm run docs:verify
```

## License

See [LICENSE](LICENSE).
