# Advanced Language Agent

[Advanced Language Agent](docs/index.html) (ALA) is a command-line application for language and documentation tasks. It can execute general requests without [task repositories](docs/wiki.html#definition-task-repository) and can load [task skills](docs/wiki.html#definition-a-skill) from them when specialized methods are needed. Task skills use the Anthropic `SKILL.md` format and are executed by an installed coding agent. ALA writes the result to standard output or a file.

A task skill is a procedure defined in an independent task repository through an Anthropic-style `SKILL.md` with `name` and `description` frontmatter. ALA discovers these descriptors recursively and makes them available to Codex, OpenCode, or Pi in an isolated workspace. ALA does not require or search task repositories for AchillesAgentLib `cskill.md`, `oskill.md`, `tskill.md`, or `dcgskill.md` descriptors.

## Install

ALA requires Node.js 20 or newer, npm, and Git. Coding-agent execution additionally requires Linux with Bubblewrap (`bwrap`); ALA fails closed instead of starting Codex, OpenCode, or Pi without it. Coding-agent CLIs remain installed once in their normal system or user locations: ALA never reinstalls or copies them into a task workspace. It resolves each launcher to its existing runtime prefix, mounts that prefix read-only, and prefers its matching executable path inside the sandbox. An external target of `/etc/resolv.conf` is mounted read-only when systemd-resolved stores it under `/run`. Codex and OpenCode also require the host to permit Bubblewrap to mount a private procfs; ALA never substitutes the host's `/proc`. Direct MainAgent execution remains available without a coding agent. From the repository root, run:

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

No task repository is required for general use. To add specialized task methods, register a task repository:

```sh
ala repo add https://example.com/owner/task-repository.git
ala repo list
ala repo remove task-repository
```

ALA accepts only a Git URL for persistent `repo add` operations and saves the resulting registration in `~/.config/ala/config.json`. Set `ALA_CONFIG_PATH` to select another configuration file, or use `--config` for one command. The repository is cloned into `$XDG_DATA_HOME/ala/repositories`, or `~/.local/share/ala/repositories` when `XDG_DATA_HOME` is not set. `repo remove` accepts the Git repository name without `.git`, its registered path, or the original Git URL. Removing its registration does not delete the managed clone. `ALA_TASK_REPOSITORIES` supplies platform-delimited local repository paths through the environment.

ALA also detects authenticated Codex, OpenCode, and Pi installations. Inspect the detected backend names with:

```sh
ala agent list
```

## Run a single task

Run a general request without a task repository:

```sh
ala "Summarize the supplied report" --file report.md
```

When task repositories are configured and a coding agent is available, that agent can select a matching task skill automatically. Select a skill explicitly when its name is known:

```sh
ala --skill translate "Translate this document to Romanian" --file document.md
```

Write the result to a file:

```sh
ala "Summarize this report" --file report.md --output summary.md
```

MainAgent may delegate suitable complex work to an installed [coding agent](docs/wiki.html#definition-coding-agent) automatically. Force one supported backend with `--agent`; `auto` uses the configured priority, which defaults to Codex, OpenCode, then Pi:

```sh
ala --agent codex "Research this topic and produce a verified summary"
ala --agent auto "Plan and validate this multi-step language task"
```

The selected coding-agent CLI must already be authenticated through its own login mechanism. By default ALA passes no model option, so each selected CLI uses its own default model. In an interactive session, `/agent <codex|opencode|pi> models` asks that backend for its available model identifiers, and `/agent <codex|opencode|pi> model <model-name>` persists a backend-specific selection in ALA configuration and applies it to every subsequent invocation. ALA's `--model`, `--tag`, `--reasoning-effort`, and `--model-config` settings continue to apply only to direct LLMAgent execution and do not override coding-agent model selection. Anthropic task-skill execution also requires one detected coding agent. ALA runs every agent and model-catalog process inside Bubblewrap, clears inherited environment variables before restoring a backend-specific allowlist, exposes its temporary workspace read-write at `/workspace`, mounts discovered task-skill directories strictly read-only under `/workspace/.agents/skills`, exposes the existing backend runtime read-only, exposes only controlled authentication/state directories read-write, and removes the workspace when the command or interactive session closes.

Mount external folders explicitly when an agent needs filesystem context. The option is repeatable; read-only is the default, while the exact `write` or `w` marker authorizes a read-write bind mount:

```sh
ala --folder ./books "Inspect the book material"
ala --folder ./books --folder ./drafts write "Update the draft from the source material"
ala --interactive --folder ./books
```

ALA canonicalizes each source and mounts it under `/workspace/.ala/folders/<alias>`. The agent receives `/workspace/.ala/folders.json` with the stable alias, source path, sandbox path, and access mode. Active folders are process- or session-scoped, are never written to ALA configuration, and force coding-agent execution. Unmounted host paths are absent from the sandbox.

Coding-agent web search is off by default. Use bare `--websearch` to enable it for one invocation, `--websearch on|off` as an explicit invocation-only override, or persist the setting during an interactive session:

```bash
ala --websearch --agent codex "Find current sources and summarize them"
ala --interactive
/websearch on
/websearch off
```

The interactive command saves `codingAgents.websearch` in the selected ALA configuration and applies it immediately without resetting the current coding-agent session. ALA maps the setting to Codex live search and OpenCode web search and fetch permissions. Pi has no ALA-managed web-search capability, so the setting does not change Pi arguments or tools. Authentication, provider quotas, site terms, and rate limits remain owned by the selected backend and its search provider.

## Run interactively

Start an interactive session. This works without a task repository:

```sh
ala
```

Start an interactive session with a specific task skill:

```sh
ala --interactive --skill translate
```

Interactive sessions also accept local slash commands. `/agent ...` commands are handled by ALA and are never sent to the LLM:

```text
/help
/agent list
/agent codex models
/agent codex model gpt-5.6-sol
/agent codex Review this task
/agent auto Produce a verified multi-step summary
/repo add https://example.com/owner/task-repository.git
/repo list
/repo remove task-repository
/symbolic detection on
/symbolic detection off
/websearch on
/websearch off
/folder add ./books
/folder add ./drafts write
/folder list
/folder remove ./books
/quit
```

`/help` lists every interactive command and explains what it does; `/agent` and `/agent help` display the same list. `/agent list` reports detected backends, `/agent <name> models` prints the model identifiers returned by that backend, `/agent <name> model <model-name>` saves its model selection, `/agent auto <prompt>` follows the configured priority, and `/agent <codex|opencode|pi> <prompt>` selects a backend. Codex models come from its app-server catalog, OpenCode models come from `opencode models`, and Pi models come from `pi --list-models`; Pi provider and model columns are rendered as `provider/model`. `/websearch on|off` persists the coding-agent web-search setting and applies it to subsequent requests in the same session. `/folder add <path> [write|w]`, `/folder list`, and `/folder remove <alias-or-path>` change only the active session's bind mounts and apply to the next coding-agent process without clearing workspace files or native continuation. While a terminal waits for a MainAgent or coding-agent response, ALA cycles through `Thinking.`, `Thinking..`, and `Thinking...`; the first supported coding-agent output event clears the indicator and subsequent intermediate assistant, command, or tool text is shown live on the diagnostic stream. ALA holds back Codex's last completed assistant event so the normalized final answer appears once on standard output. Benign Codex stdin notices and stale-rollout catalog diagnostics are not rendered during a successful turn. The animation and live diagnostic routing are disabled when the interactive input or diagnostic output is not a terminal, so redirected output remains clean. `/repo add`, `/repo list`, and `/repo remove` manage persistent task repository registrations locally. Removal accepts the Git repository name without `.git`, such as `task-repository`, while the registered path and original Git URL remain supported. In a terminal, press TAB after `/repo remove ` or after a partial name to complete matching registered repository names. An addition or removal refreshes the active skill catalog immediately, so the next prompt in the same session sees the change. Refreshing changes only strict read-only task-skill mounts for the next agent process and preserves workspace files, active folder mounts, selected backend, native continuation, MainAgent conversation, symbolic-detection setting, and web-search setting. Symbolic detection is off by default for each session; `/symbolic detection on` enables instruction-only symbolic task routing, while uncertain matches remain available for coding-agent catalog selection, and `off` disables it again. Enter `/quit`, `/exit`, `:quit`, or `:exit` to close the session.

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
