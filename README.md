# Advanced Language Agent

[Advanced Language Agent](docs/index.html) (ALA) is a command-line application for language and documentation tasks. It executes general requests through AchillesAgentLib and delegates bounded work to an installed coding agent. ALA mounts exactly the directories the caller supplies through `--cwd` and `--folder`; it does not discover, create, mount or overlay task skills. ALA writes the result to standard output or a file.

## Install

ALA requires Node.js 20 or newer, npm, and Git. Coding-agent execution additionally requires Linux with Bubblewrap (`bwrap`); ALA fails closed instead of starting Codex, OpenCode, Pi, or Claude Code without it. Coding-agent CLIs remain installed once in their normal system or user locations: ALA never reinstalls or copies them. It resolves each launcher to its existing runtime prefix, mounts that prefix read-only, and prefers its matching executable path inside the sandbox. Prefixes below the mounted working directory use a private runtime path so the workspace mount cannot hide the installed executable; other prefixes retain their existing paths. An external target of `/etc/resolv.conf` is mounted read-only when systemd-resolved stores it under `/run`. Codex and OpenCode also require Bubblewrap to mount a private procfs; ALA never substitutes the caller's `/proc`. It first uses a private user namespace. In a capability-bounded nested container where that extra user namespace cannot mount procfs, ALA may use the outer sandbox capability to construct the PID namespace and private procfs, then drops all capabilities before starting the coding agent. Codex is told not to construct a second native sandbox: its `danger-full-access` setting is scoped inside ALA's Bubblewrap boundary, where only the mounted directories and controlled home remain writable. Direct MainAgent execution remains available without a coding agent. From the repository root, run:

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

## Private directories

Pass repeatable `--ignore /absolute/directory` options to mask existing directories inside the coding-agent sandbox. Each masked directory appears empty and read-only; its name remains visible and its host contents remain unchanged. Masks cover canonical paths, folder aliases, and mounts sourced from ignored subdirectories. Invalid, missing, unmounted paths and masks covering the working directory are rejected. Supply the options again when resuming a session. This option selects sandboxed coding-agent execution.

```sh
ala --ca auto --cwd /work/project --ignore /work/project/.private --task "Review the project"
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

User configuration lives in `$HOME/.ala/config.json`. Set `ALA_CONFIG_PATH` to another root directory when an embedding application needs an isolated configuration; ALA then uses `<ALA_CONFIG_PATH>/.ala/config.json`. The explicit `--config <file>` option remains available for a one-command file override.

The file holds three optional fields and nothing else:

```json
{
  "codingAgent": "codex",
  "models": { "codex": "gpt-5.6-sol" },
  "efforts": { "codex": "high" }
}
```

`codingAgent` is the default backend (`codex`, `opencode`, `pi`, or `claude`). `models` sets one native model per backend, and `efforts` sets one native effort per backend that has a model in `models`. ALA rejects any other field, including the old `version` and `codingAgents` layout, with "ALA configuration supports only codingAgent, models and efforts". Rewrite an older file by hand; ALA does not migrate it. A missing file means no default agent and no models.

ALA writes a transcript only for explicit sessions started with `--session-id`. Set `ALA_SESSIONS` to the directory that should hold them; a relative value resolves against `--cwd`. When it is unset, ALA uses `<cwd>/.ala`. Executions without `--session-id` leave no ALA history behind.

ALA also detects authenticated Codex, OpenCode, Pi, and Claude Code installations. The Claude Code executable is found through `CLAUDE_BIN`, then `~/.local/bin/claude`, then `PATH`. Inspect the detected backend names with:

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

MainAgent may delegate suitable complex work to an installed [coding agent](docs/wiki.html#definition-coding-agent) automatically. Force one supported backend with `--ca`. `auto` uses `codingAgent` from the configuration when that backend is installed, otherwise the first available of Codex, OpenCode, Pi, Claude Code. That order is fixed. `--agent` remains a compatibility alias:

```sh
ala --ca codex "Research this topic and produce a verified summary"
ala --ca auto "Plan and validate this multi-step language task"
```

The selected coding-agent CLI must already be authenticated through its own login mechanism. When `models` has no entry for the selected backend, ALA passes no model option and the CLI uses its own default. In an interactive session, `/agent use <codex|opencode|pi|claude>` saves `codingAgent`, `/agent <codex|opencode|pi|claude> models` asks that backend for its available model identifiers, `/agent <codex|opencode|pi|claude> model <model-name>` saves the backend's entry in `models`, and `/agent <codex|opencode|pi|claude> model default` removes it so the agent CLI chooses its default again. Both model commands clear that backend's saved effort. ALA applies each change to every subsequent invocation. With `--ca`, `--model` replaces the selected backend's saved model for one invocation and drops its saved effort when the model differs. `--tag`, `--reasoning-effort`, and `--model-config` apply only to direct LLMAgent execution. ALA runs every agent and model-catalog process inside Bubblewrap, clears inherited environment variables before restoring a backend-specific allowlist, mounts the caller's `--cwd` and `--folder` directories at their canonical or aliased paths, exposes the existing backend runtime read-only, exposes only controlled authentication/state directories read-write, and retains the temporary directory it created when `--cwd` is omitted.

Claude Code (`--ca claude`) needs version 2.1.0 or newer and uses only Anthropic credentials: its own `claude` login, or `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, or `CLAUDE_CODE_OAUTH_TOKEN` from the environment. ALA points `CLAUDE_CONFIG_DIR` at `.claude` in the sandbox home, so the login, `.claude.json`, settings and native sessions all live there. Without `--home`, ALA mounts the host's `CLAUDE_CONFIG_DIR`, or `~/.claude` when that variable is unset. `/agent claude models` reads the model list from the CLI's `initialize` response and makes no model call.

Embedding applications can select a persistent coding-agent home, an existing work tree, extra directories, a prompt file, and Streamable HTTP MCP servers explicitly:

```sh
ala --home /robot/home --cwd /project --folder /shared --folder /scratch write \
  --taskFile task.prompt --MCPServers desktop=http://127.0.0.1:48100/mcp --ca codex
```

`--home` is bound as the sandbox home and supplies saved agent authentication and configuration. `--cwd <path> [as <alias>]` is the writable working directory, mounted at its canonical path or under `/workspace/<alias>`. `--folder <path> [write] [as <alias>]` mounts extra directories read-only unless marked `write`. `--task` or `--taskFile` supplies the prompt, and `--MCPServers` injects temporary URL configuration into the selected coding agent (Codex, OpenCode, or Claude Code) without rewriting its saved config. Interactive folder mounts are not supported.

Web search is always on for coding agents. ALA starts Codex with `--search` and OpenCode with its Exa search and its `websearch` and `webfetch` tools allowed. Claude Code keeps its built-in `WebSearch` and `WebFetch` tools, which are on by default. Pi has no web search. There is no switch to turn it off, and `--websearch` is an unknown option. Search authentication, quotas, and rate limits belong to the selected backend and its search provider.

## Continue a coding-agent task

Use a new UUID to create a persistent session. Later invocations need the same session id and the same transcript location, so keep `--cwd` and `ALA_SESSIONS` stable and pass the same `--home` for the coding agent's native state. `--ca` is optional here; without it ALA behaves as `--ca auto`, which picks a backend on the first turn and keeps the session's saved backend after that.

```sh
ala --home /robot/home --cwd /project --ca codex \
  --session-id 11111111-1111-4111-8111-111111111111 --task "Inspect the project"
ala --home /robot/home --cwd /project --ca codex \
  --session-id 11111111-1111-4111-8111-111111111111 --resume-session --task "Add tests"
```

ALA appends every turn to `$ALA_SESSIONS/sessions/<uuid>.jsonl`, which defaults to `<cwd>/.ala/sessions/<uuid>.jsonl`. Each line is one JSON record: the session header, the user's text, buffered coding-agent messages, AchillesAgentLib tool calls, the final result, the turn status, and the backend with its native continuation. ALA never rewrites a line. `--resume-session` reads the last continuation from that file. A session whose first turn failed before the coding agent started has no continuation yet, so the next call omits `--resume-session`; once a continuation exists, ALA refuses to continue without it. Stop interrupts execution and records the turn as `interrupted`. Missing native state fails explicitly rather than starting an unrelated conversation. A `.lock` file next to the transcript blocks a second process; a lock written on another host is never removed automatically.

Pass `--turn-id <id>` to label the turn's records with your own identifier of 1 to 128 letters, digits, `-` or `_`. Without it, ALA generates a random UUID. The option requires `--session-id`.

Read transcripts through the package export instead of parsing the files:

```js
import { listSessions, readSession } from 'advanced-language-agent/transcript';

const sessions = await listSessions('/project/.ala');
const session = await readSession('/project/.ala', sessions[0].id);
console.log(session.turns.map((turn) => [turn.user, turn.status, turn.final]));
```

The module also exports `sessionTranscriptPath`, `readTranscriptRecords`, `foldTranscript`, `readTurn`, `readSessionSummary`, and a synchronous `...Sync` variant of every reader.

An embedding process can add `--control-stdin` and leave out `--task` and `--taskFile`. ALA then opens the session, emits `session-ready`, and waits for the first stdin line to carry the turn prompt: `{"type":"prompt","prompt":"<text for the coding agent>","displayText":"<the user's own text>"}`. The coding agent gets `prompt` and the transcript records `displayText`, so a host can wrap the user's words in its own instructions without writing a prompt file. Both fields may hold up to 1 MiB. Any other first record is rejected, and if stdin closes first the coding agent never starts and ALA exits with an error. With `--task` or `--taskFile`, stdin carries only follow-ups. `--control-stdin` cannot be combined with `--stdin`.

After the prompt, the process can send follow-up messages such as `{"type":"message","id":"request-1","message":"Also check the tests"}`, each up to 32768 characters. ALA records each accepted message as another `user` record of the turn, using the optional `displayText` field instead of `message` when the host supplies it. Codex app-server, Pi RPC, and Claude Code support live steering. Claude Code receives each follow-up on its standard input as soon as it arrives, and its turn ends after the result for the last delivered message. The current OpenCode adapter queues follow-ups until the active invocation finishes. Structured stderr receipts distinguish `delivered` from `queued`; stdout remains the final response. Pending messages are execution-local and are cancelled on Stop. See the [session command reference](docs/commands.html) for the protocol.

Select native permission policy with `--permissions ask-for-approval|full-access`; the standalone default is full-access inside Bubblewrap. An embedding host must attach control stdin to display and answer native approval requests. Codex uses native app-server approval decisions; OpenCode uses its authenticated native server and once/always/reject replies, without changing project `opencode.json`. Claude Code sends each tool permission prompt as a `can_use_tool` control request, which ALA offers to the host as Allow once or Deny. Pi supports full-access only and requires version 0.85.1 or a verified compatible RPC release. An older installation must be upgraded separately or selected through `PI_BIN`; ALA does not modify global installations. Missing reply capability declines an operation requiring approval rather than granting access. Native remembered grants are not an ALA authorization cache and need not survive a new native process.

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
/agent use opencode
/agent codex models
/agent codex model gpt-5.6-sol
/agent codex model default
/agent codex Review this task
/agent auto Produce a verified multi-step summary
/permissions
/permissions ask-for-approval
/permissions full-access
/quit
```

`/help` lists every interactive command. `/agent` commands discover a backend, set the default backend, inspect or select its native model, and delegate prompts. While a terminal waits, ALA renders a transient thinking indicator and supported live backend events on standard error, leaving the normalized final result on standard output. Enter `/quit`, `/exit`, `:quit`, or `:exit` to close the session.

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
