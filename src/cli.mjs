import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { HELP_TEXT, parseArguments } from './arguments.mjs';
import { loadAchillesAgentLib } from './achilles-loader.mjs';
import {
  canonicalRepositoryPath,
  loadConfig,
  resolveActiveRepositories,
  resolveConfigPath,
  saveConfig
} from './config.mjs';
import { ALAError, asALAError, EXIT_CODES } from './errors.mjs';
import { composePrompt, loadRequest } from './input.mjs';
import { createInteractiveCompleter } from './interactive-completion.mjs';
import { createThinkingIndicator } from './interactive-status.mjs';
import { writeResult } from './output.mjs';
import { validateTaskRepository } from './repositories.mjs';
import {
  isGitRepositoryUrl,
  managedRepositoryPath,
  prepareRepositorySource,
  registeredRepositoryName,
  repositorySourceName
} from './repository-sources.mjs';
import { createRuntime, feedbackPrompt } from './runtime.mjs';
import { createRuntimeEventSink } from './runtime-events.mjs';
import { discoverCodingAgents } from './coding-agents/discovery.mjs';
import { resolveFolderRequests } from './coding-agents/folders.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const INTERACTIVE_HELP_TEXT = `Interactive commands:
  /help                          Show this complete command list
  /agent | /agent help           Show this complete command list
  /agent list                    List detected coding-agent backends
  /agent <name> models           List models available to a coding-agent backend
  /agent <name> model <model>    Persist the model used by a coding-agent backend
  /agent <name> model default    Remove the override and use the agent default
  /agent auto <prompt>           Delegate to the first available backend
  /agent codex <prompt>          Delegate to Codex
  /agent opencode <prompt>       Delegate to OpenCode
  /agent pi <prompt>             Delegate to Pi
  /repo add <git-url>             Clone, register, and load a task repository
  /repo list                      List registered task repositories
  /repo remove <name>             Unregister a task repository; TAB completes names
  /symbolic detection on         Enable symbolic task routing
  /symbolic detection off        Disable symbolic task routing
  /websearch on                  Persist and enable coding-agent web search
  /websearch off                 Persist and disable coding-agent web search
  /folder add <path> [write|w] [as <alias>]
                                  Mount a folder for this session; read-only by default
  /folder list                   List active folder mounts and access modes
  /folder remove <alias|path>    Remove a folder from subsequent agent invocations
  /quit | /exit | :quit | :exit  Close the interactive session`;

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) return trimmed.slice(1, -1);
  return trimmed;
}

function parseInteractiveFolderAdd(line) {
  let value = line.slice('/folder add'.length).trim();
  let alias = null;
  const aliasMatch = value.match(/\s+as\s+(\S+)$/u);
  if (aliasMatch) {
    alias = aliasMatch[1];
    value = value.slice(0, aliasMatch.index).trim();
  }
  let writable = false;
  const mode = value.match(/\s+(write|w)$/u);
  if (mode) {
    writable = true;
    value = value.slice(0, mode.index).trim();
  }
  value = unquote(value);
  if (!value) throw new ALAError('Usage: /folder add <path> [write|w] [as <alias>]', EXIT_CODES.usage);
  return { path: value, writable, alias };
}

async function packageVersion() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

async function runRepositoryCommand(options, io, env, afterMutation = null) {
  if (options.help) {
    io.stdout.write(`${HELP_TEXT}\n`);
    return EXIT_CODES.success;
  }
  if (options.action === 'add' && !isGitRepositoryUrl(options.target)) {
    throw new ALAError('ala repo add requires a Git URL.', EXIT_CODES.usage);
  }
  const configPath = resolveConfigPath({ cliPath: options.configPath, env, cwd: io.cwd });
  const config = await loadConfig(configPath);
  if (options.action === 'list') {
    const paths = config.taskRepositories.map((entry) => entry.path);
    const rendered = options.json ? `${JSON.stringify(paths, null, 2)}\n` : paths.map((entry) => `${entry}\n`).join('');
    io.stdout.write(rendered);
    return EXIT_CODES.success;
  }

  if (options.action === 'add') {
    let created = false;
    let registered = false;
    let repositoryPath;
    try {
      ({ repositoryPath, created } = await prepareRepositorySource(options.target, env));
      await validateTaskRepository(repositoryPath);
      if (!config.taskRepositories.some((entry) => entry.path === repositoryPath)) {
        config.taskRepositories.push({ path: repositoryPath });
        await saveConfig(configPath, config);
        registered = true;
      }
      try {
        await afterMutation?.(config);
      } catch (error) {
        if (registered) {
          config.taskRepositories = config.taskRepositories.filter((entry) => entry.path !== repositoryPath);
          await saveConfig(configPath, config);
        }
        throw error;
      }
    } catch (error) {
      if (created && repositoryPath) await rm(repositoryPath, { recursive: true, force: true });
      throw error;
    }
    io.stdout.write(`${repositoryPath}\n`);
    return EXIT_CODES.success;
  }

  const lexicalPath = isGitRepositoryUrl(options.target)
    ? managedRepositoryPath(options.target, env)
    : resolve(io.cwd, options.target);
  let canonicalPath = lexicalPath;
  try { canonicalPath = await canonicalRepositoryPath(options.target, io.cwd); } catch {}
  let index = config.taskRepositories.findIndex(
    (entry) => entry.path === canonicalPath || entry.path === lexicalPath
  );
  if (index === -1 && !isGitRepositoryUrl(options.target) && !/[\\/]/u.test(options.target)) {
    const requestedName = repositorySourceName(options.target);
    const matches = config.taskRepositories
      .map((entry, entryIndex) => ({ entry, entryIndex }))
      .filter(({ entry }) => registeredRepositoryName(entry.path) === requestedName);
    if (matches.length > 1) {
      throw new ALAError(
        `Task repository name is ambiguous: ${requestedName}. Use its registered path or Git URL.`,
        EXIT_CODES.repository
      );
    }
    if (matches.length === 1) index = matches[0].entryIndex;
  }
  if (index === -1) throw new ALAError(`Task repository is not registered: ${options.target}`, EXIT_CODES.repository);
  const [removed] = config.taskRepositories.splice(index, 1);
  await saveConfig(configPath, config);
  try {
    await afterMutation?.(config);
  } catch (error) {
    config.taskRepositories.splice(index, 0, removed);
    await saveConfig(configPath, config);
    throw error;
  }
  io.stdout.write(`${removed.path}\n`);
  return EXIT_CODES.success;
}

async function runAgentCommand(options, io, env) {
  if (options.help) {
    io.stdout.write(`${HELP_TEXT}\n`);
    return EXIT_CODES.success;
  }
  const configPath = resolveConfigPath({ cliPath: options.configPath, env, cwd: io.cwd });
  const config = await loadConfig(configPath);
  const agents = await discoverCodingAgents({ env, priority: config.codingAgents.priority });
  const names = agents.filter((agent) => agent.available).map((agent) => agent.name);
  if (options.json) io.stdout.write(`${JSON.stringify(names, null, 2)}\n`);
  else io.stdout.write(names.map((name) => `${name}\n`).join(''));
  return EXIT_CODES.success;
}

async function interactiveLoop(runtime, initialPrompt, initialInstruction, options, io, env, signal) {
  const configPath = resolveConfigPath({ cliPath: options.configPath, env, cwd: io.cwd });
  let activeConfig = await loadConfig(configPath);
  let repositoryPaths = activeConfig.taskRepositories.map((entry) => entry.path);
  const terminalDiagnostics = Boolean(io.stdin.isTTY && io.stderr.isTTY);
  const thinking = createThinkingIndicator(io.stderr, {
    enabled: terminalDiagnostics
  });
  const liveOutput = terminalDiagnostics ? (text) => {
    thinking.stop();
    io.stderr.write(text);
  } : null;
  runtime.setCodingAgentOutputSink?.(liveOutput);
  const readline = createInterface({
    input: io.stdin,
    output: io.stderr,
    terminal: Boolean(io.stdin.isTTY),
    completer: createInteractiveCompleter(() => repositoryPaths)
  });
  let previousResult = null;
  try {
    if (initialPrompt) {
      previousResult = await thinking.run(
        () => runtime.execute(initialPrompt, { signal, instruction: initialInstruction })
      );
      await writeResult(previousResult, { stdout: io.stdout });
    }
    const handleLine = async (rawLine) => {
      const line = String(rawLine).trim();
      if (!line) return false;
      if (line === ':quit' || line === ':exit' || line === '/quit' || line === '/exit') return true;
      if (line.startsWith('/')) {
        try {
          const parts = line.split(/\s+/u);
          if (line === '/help') {
            io.stderr.write(`${INTERACTIVE_HELP_TEXT}\n`);
          } else if (parts[0] === '/agent') {
            const action = parts[1] || 'help';
            if (action === 'help') {
              io.stderr.write(`${INTERACTIVE_HELP_TEXT}\n`);
            } else if (action === 'list') {
              const names = runtime.listCodingAgents();
              io.stdout.write(names.map((name) => `${name}\n`).join(''));
            } else if (['codex', 'opencode', 'pi'].includes(action) && parts[2] === 'models') {
              if (parts.length !== 3) throw new ALAError(`Usage: /agent ${action} models`, EXIT_CODES.usage);
              const models = await runtime.listCodingAgentModels(action, { signal });
              io.stdout.write(models.map((model) => `${model}\n`).join(''));
            } else if (['codex', 'opencode', 'pi'].includes(action) && parts[2] === 'model') {
              const model = parts.slice(3).join(' ').trim();
              if (!model) throw new ALAError(`Usage: /agent ${action} model <model-name|default>`, EXIT_CODES.usage);
              const useDefault = model === 'default';
              const nextModels = { ...activeConfig.codingAgents.models };
              if (useDefault) delete nextModels[action];
              else nextModels[action] = model;
              const nextConfig = {
                ...activeConfig,
                codingAgents: {
                  ...activeConfig.codingAgents,
                  models: nextModels
                }
              };
              await saveConfig(configPath, nextConfig);
              activeConfig = nextConfig;
              runtime.setCodingAgentModel(action, useDefault ? null : model);
              io.stderr.write(useDefault
                ? `ala: ${action} model reset to agent default\n`
                : `ala: ${action} model set to ${model}\n`);
            } else if (['auto', 'codex', 'opencode', 'pi'].includes(action)) {
              const prompt = parts.slice(2).join(' ').trim();
              if (!prompt) throw new ALAError(`/agent ${action} requires a prompt.`, EXIT_CODES.usage);
              const result = await thinking.run(
                () => runtime.executeAgent(prompt, { agent: action, signal })
              );
              await writeResult(result, { stdout: io.stdout });
            } else {
              throw new ALAError(`Unknown interactive command: ${line}`, EXIT_CODES.usage);
            }
          } else if (parts[0] === '/repo') {
            const action = parts[1];
            if (!['add', 'remove', 'list'].includes(action)) {
              throw new ALAError('Usage: /repo add <git-url> | /repo remove <name-or-path-or-git-url> | /repo list', EXIT_CODES.usage);
            }
            const target = parts.slice(2).join(' ').trim() || null;
            if (['add', 'remove'].includes(action) && !target) {
              const targetDescription = action === 'add' ? 'a Git URL' : 'a repository name, path, or Git URL';
              throw new ALAError(`/repo ${action} requires ${targetDescription}.`, EXIT_CODES.usage);
            }
            if (action === 'add' && !isGitRepositoryUrl(target)) {
              throw new ALAError('/repo add requires a Git URL.', EXIT_CODES.usage);
            }
            if (action === 'list' && target) {
              throw new ALAError('/repo list does not accept a repository name, path, or Git URL.', EXIT_CODES.usage);
            }
            const refresh = action === 'list' ? null : async (config) => {
              const repositories = await resolveActiveRepositories({
                config,
                env,
                cwd: io.cwd
              });
              await runtime.refreshRepositories(repositories);
              activeConfig = config;
              repositoryPaths = config.taskRepositories.map((entry) => entry.path);
            };
            await runRepositoryCommand({
              command: 'repo', action, target, configPath: options.configPath, json: false, help: false
            }, io, env, refresh);
            if (action !== 'list') {
              io.stderr.write(`ala: repository catalog refreshed (${runtime.skills.length} skills)\n`);
            }
          } else if (parts[0] === '/symbolic') {
            if (parts[1] !== 'detection' || !['on', 'off'].includes(parts[2])) {
              throw new ALAError('Usage: /symbolic detection on|off', EXIT_CODES.usage);
            }
            runtime.setSymbolicDetection(parts[2] === 'on');
            io.stderr.write(`ala: symbolic detection ${parts[2]}\n`);
          } else if (parts[0] === '/websearch') {
            if (parts.length !== 2 || !['on', 'off'].includes(parts[1])) {
              throw new ALAError('Usage: /websearch on|off', EXIT_CODES.usage);
            }
            const enabled = parts[1] === 'on';
            const nextConfig = {
              ...activeConfig,
              codingAgents: { ...activeConfig.codingAgents, websearch: enabled }
            };
            await saveConfig(configPath, nextConfig);
            activeConfig = nextConfig;
            runtime.setWebsearch(enabled);
            io.stderr.write(`ala: websearch ${parts[1]}\n`);
          } else if (parts[0] === '/folder') {
            const action = parts[1];
            if (action === 'add') {
              const request = parseInteractiveFolderAdd(line);
              const record = await runtime.addFolder(request.path, request.writable, request.alias);
              io.stderr.write(`ala: folder ${record.alias} mounted ${record.access} at ${record.workspacePath}\n`);
            } else if (action === 'list' && parts.length === 2) {
              const records = runtime.listFolders();
              io.stdout.write(records.map((record) => (
                `${record.alias}\t${record.access}\t${record.sourcePath}\t${record.workspacePath}\n`
              )).join(''));
            } else if (action === 'remove') {
              const value = unquote(line.slice('/folder remove'.length));
              if (!value) throw new ALAError('Usage: /folder remove <alias-or-path>', EXIT_CODES.usage);
              await runtime.removeFolder(value);
              io.stderr.write(`ala: folder removed: ${value}\n`);
            } else {
              throw new ALAError(
                'Usage: /folder add <path> [write|w] [as <alias>] | /folder list | /folder remove <alias-or-path>',
                EXIT_CODES.usage
              );
            }
          } else {
            throw new ALAError(`Unknown interactive command: ${line}`, EXIT_CODES.usage);
          }
        } catch (error) {
          const alaError = asALAError(error);
          io.stderr.write(`ala: ${alaError.message}\n`);
        }
        return false;
      }
      const prompt = options.skill && previousResult !== null ? feedbackPrompt(previousResult, line) : line;
      previousResult = await thinking.run(() => runtime.execute(prompt, { signal }));
      await writeResult(previousResult, { stdout: io.stdout });
      return false;
    };
    if (io.stdin.isTTY) {
      while (true) {
        if (await handleLine(await readline.question('ala> '))) break;
      }
    } else {
      for await (const line of readline) {
        if (await handleLine(line)) break;
      }
    }
  } finally {
    runtime.setCodingAgentOutputSink?.(null);
    readline.close();
  }
}

async function runExecution(options, io, env) {
  if (options.help) {
    io.stdout.write(`${HELP_TEXT}\n`);
    return EXIT_CODES.success;
  }
  if (options.version) {
    io.stdout.write(`${await packageVersion()}\n`);
    return EXIT_CODES.success;
  }
  if (options.modelConfigPath) env.LLM_MODELS_CONFIG_PATH = resolve(io.cwd, options.modelConfigPath);

  const configPath = resolveConfigPath({ cliPath: options.configPath, env, cwd: io.cwd });
  const config = await loadConfig(configPath);
  const inferredInteractive = options.interactive || (options.instructionParts.length === 0 && io.stdin.isTTY);
  const eventSink = createRuntimeEventSink({ stream: io.stderr, env });
  const folders = await resolveFolderRequests(options.folders, io.cwd);
  const repositories = await resolveActiveRepositories({
    config,
    env,
    cwd: io.cwd
  });
  const achilles = await loadAchillesAgentLib({
    overridePath: options.achillesPath,
    env,
    cwd: io.cwd
  });
  const codingAgents = await discoverCodingAgents({ env, priority: config.codingAgents.priority });
  if (options.agent || folders.length > 0) {
    const available = codingAgents.filter((agent) => agent.available);
    const requested = options.agent || 'auto';
    const selected = requested === 'auto'
      ? available[0]
      : available.find((agent) => agent.name === requested);
    if (!selected) throw new ALAError(`Coding agent is not available: ${requested}`, EXIT_CODES.execution);
  }
  const runtime = await createRuntime({
    achillesModule: achilles.module,
    repositories,
    codingAgents,
    codingAgentModels: config.codingAgents.models,
    folders,
    websearch: options.websearch ?? config.codingAgents.websearch,
    cwd: io.cwd,
    options,
    env,
    diagnostics: io.stderr,
    eventSink
  });
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    runtime.cancel('SIGINT');
  };
  process.once('SIGINT', interrupt);
  try {
    let initialPrompt = null;
    let initialInstruction = null;
    if (options.instructionParts.length > 0 || options.sources.length > 0 || !inferredInteractive) {
      const request = await loadRequest({
        instructionParts: options.instructionParts,
        sources: options.sources,
        stdin: io.stdin,
        cwd: io.cwd,
        fetchImpl: io.fetch
      });
      initialPrompt = composePrompt(request);
      initialInstruction = request.instruction;
    }
    if (inferredInteractive) {
      await interactiveLoop(runtime, initialPrompt, initialInstruction, options, io, env, controller.signal);
    } else {
      const result = await runtime.execute(initialPrompt, {
        signal: controller.signal, instruction: initialInstruction
      });
      const outputPath = options.output ? resolve(io.cwd, options.output) : null;
      await writeResult(result, { outputPath, force: options.force, stdout: io.stdout });
    }
    return EXIT_CODES.success;
  } finally {
    process.removeListener('SIGINT', interrupt);
    await runtime.close();
  }
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  fetchImpl = fetch
} = {}) {
  const io = { stdin, stdout, stderr, cwd, fetch: fetchImpl };
  try {
    const options = parseArguments(argv);
    if (options.command === 'repo') return await runRepositoryCommand(options, io, env);
    if (options.command === 'agent') return await runAgentCommand(options, io, env);
    return await runExecution(options, io, env);
  } catch (error) {
    const alaError = asALAError(error);
    stderr.write(`ala: ${alaError.message}\n`);
    return alaError.exitCode;
  }
}
