# Advanced Language Agent

[Advanced Language Agent](docs/index.html) (ALA) is a command-line application for language and documentation tasks. It can execute general requests without [task repositories](docs/wiki.html#definition-task-repository) and can load [A-Skills](docs/wiki.html#definition-a-skill) when specialized task methods are needed. It writes the result to standard output or a file.

An A-Skill is an [AchillesAgentLib](docs/wiki.html#definition-achilles-agent-lib) skill supplied by an independent task repository. ALA provides the CLI and execution runtime; the task repository provides the method for translation, research, writing, verification, or another language task.

## Install

ALA requires Node.js 20 or newer, npm, and Git. From the repository root, run:

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
ala repo add /absolute/path/to/task-repository
ala repo list
```

ALA saves registered repositories in `$XDG_CONFIG_HOME/ala/config.json`, or in `~/.config/ala/config.json` when `XDG_CONFIG_HOME` is not set.

ALA also detects authenticated Codex, OpenCode, and Pi installations. Inspect the detected backend names with:

```sh
ala agent list
```

## Run a single task

Run a general request without a task repository:

```sh
ala "Summarize the supplied report" --file report.md
```

When task repositories are configured, ALA can select a matching A-Skill automatically. Select an A-Skill explicitly when its name is known:

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

The selected coding-agent CLI must already be authenticated through its own login mechanism. ALA runs it in a temporary workspace and removes that workspace when the command or interactive session closes.

## Run interactively

Start an interactive session. This works without a task repository:

```sh
ala
```

Start an interactive session with a specific A-Skill:

```sh
ala --interactive --skill translate
```

Interactive sessions also accept local slash commands. `/agent ...` commands are handled by ALA and are never sent to the LLM:

```text
/agent list
/agent codex Review this task
/agent auto Produce a verified multi-step summary
/symbolic detection on
/symbolic detection off
/quit
```

`/agent list` reports detected backends, `/agent auto <prompt>` follows the configured priority, and `/agent <codex|opencode|pi> <prompt>` selects a backend. Symbolic detection is off by default for each session; `/symbolic detection on` enables instruction-only symbolic task routing with safe fallback to MainAgent, and `off` disables it again. Enter `/quit`, `/exit`, `:quit`, or `:exit` to close the session.

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
