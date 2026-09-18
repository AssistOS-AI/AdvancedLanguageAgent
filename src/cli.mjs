import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { HELP_TEXT, parseArguments } from './arguments.mjs';
import { loadAchillesAgentLib } from './achilles-loader.mjs';
import { loadConfig, resolveConfigPath, saveConfig } from './config.mjs';
import { ALAError, asALAError, EXIT_CODES } from './errors.mjs';
import { composePrompt, loadRequest } from './input.mjs';
import { createInteractiveCompleter } from './interactive-completion.mjs';
import { createPermissionCommand } from './interactive-permissions.mjs';
import { createThinkingIndicator } from './interactive-status.mjs';
import { writeResult } from './output.mjs';
import { SANDBOX_WORKSPACE } from './coding-agents/paths.mjs';
import { createRuntime } from './runtime.mjs';
import { createRuntimeEventSink } from './runtime-events.mjs';
import { discoverCodingAgents } from './coding-agents/discovery.mjs';
import { openSessionState } from './session-state.mjs';
import { runControlledExecution } from './controlled-execution.mjs';

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
  /websearch on                  Persist and enable coding-agent web search
  /websearch off                 Persist and disable coding-agent web search
  /permissions [mode]            Show or set ask-for-approval or full-access for this session
  /quit | /exit | :quit | :exit  Close the interactive session`;

async function packageVersion() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  return manifest.version;
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

function workspaceAliasTarget(alias) {
  if (alias === undefined) return null;
  if (typeof alias !== 'string' || !alias.trim() || ['.', '..'].includes(alias) || /[/\\\0]/u.test(alias)) {
    throw new ALAError('--cwd alias must be a single nonempty folder name.', EXIT_CODES.usage);
  }
  return `${SANDBOX_WORKSPACE}/${alias}`;
}

async function interactiveLoop(runtime, initialPrompt, initialInstruction, options, io, env, signal) {
  const permissionCommand = createPermissionCommand(runtime, options.permissionMode);
  const configPath = resolveConfigPath({ cliPath: options.configPath, env, cwd: io.cwd });
  let activeConfig = await loadConfig(configPath);
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
    completer: createInteractiveCompleter()
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
                  efforts: Object.fromEntries(Object.entries(activeConfig.codingAgents.efforts || {}).filter(([name]) => name !== action)),
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
          } else if (parts[0] === '/permissions') {
            io.stderr.write(`ala: ${permissionCommand(parts)}\n`);
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
          } else {
            throw new ALAError(`Unknown interactive command: ${line}`, EXIT_CODES.usage);
          }
        } catch (error) {
          const alaError = asALAError(error);
          io.stderr.write(`ala: ${alaError.message}\n`);
        }
        return false;
      }
      previousResult = await thinking.run(() => runtime.execute(line, { signal }));
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

  const executionCwd = options.cwd ? await realpath(resolve(io.cwd, options.cwd)) : null;
  if (executionCwd && !(await stat(executionCwd)).isDirectory()) {
    throw new ALAError('--cwd must reference an existing directory.', EXIT_CODES.usage);
  }
  const workspaceTarget = workspaceAliasTarget(options.cwdAlias);
  const executionHome = options.home ? await realpath(resolve(io.cwd, options.home)) : null;
  if ((options.resumeSession || options.controlStdin) && !options.sessionId) {
    throw new ALAError('--resume-session and --control-stdin require --session-id.', EXIT_CODES.usage);
  }
  if (options.sessionId && (!options.cwd || !options.home || !options.agent || options.interactive)) {
    throw new ALAError('--session-id requires --cwd, --home and --ca in one-shot mode.', EXIT_CODES.usage);
  }
  if (options.controlStdin && (options.sources.some((source) => source.type === 'stdin')
      || (!options.taskFile && options.instructionParts.length === 0))) {
    throw new ALAError('--control-stdin requires a task argument/file and cannot read the prompt from stdin.', EXIT_CODES.usage);
  }
  if (executionHome && !(await stat(executionHome)).isDirectory()) {
    throw new ALAError('--home must reference an existing directory.', EXIT_CODES.usage);
  }
  const runtimeEnv = executionHome
    ? { ...env, HOME: executionHome, CODEX_HOME: resolve(executionHome, '.codex') }
    : env;
  if (options.taskFile) {
    const taskFile = resolve(io.cwd, options.taskFile);
    options.instructionParts.unshift(await readFile(taskFile, 'utf8'));
  }
  const configPath = resolveConfigPath({ cliPath: options.configPath, env: runtimeEnv, cwd: executionCwd || io.cwd });
  const config = await loadConfig(configPath);
  const inferredInteractive = options.interactive || (options.instructionParts.length === 0 && io.stdin.isTTY);
  if (options.sessionId && inferredInteractive) {
    throw new ALAError('--session-id requires a one-shot task prompt.', EXIT_CODES.usage);
  }
  const eventSink = createRuntimeEventSink({ stream: io.stderr,
    env: options.sessionId ? { ...env, ALA_EVENT_STREAM: '1' } : env });
  const achilles = await loadAchillesAgentLib({
    overridePath: options.achillesPath,
    env,
    cwd: io.cwd
  });
  const codingAgents = await discoverCodingAgents({ env: runtimeEnv, priority: config.codingAgents.priority });
  if (options.agent) {
    const available = codingAgents.filter((agent) => agent.available);
    const requested = options.agent || 'auto';
    const selected = requested === 'auto'
      ? available[0]
      : available.find((agent) => agent.name === requested);
    if (!selected) throw new ALAError(`Coding agent is not available: ${requested}`, EXIT_CODES.execution);
  }
  const sessionState = options.sessionId ? await openSessionState({
    id: options.sessionId, home: executionHome, workspace: executionCwd, resume: options.resumeSession
  }) : null;
  let runtime;
  try { runtime = await createRuntime({
    achillesModule: achilles.module,
    codingAgents,
    codingAgentModels: config.codingAgents.models,
    codingAgentEfforts: config.codingAgents.efforts,
    workspace: executionCwd,
    workspaceTarget,
    home: executionHome,
    mcpServers: options.mcpServers,
    websearch: options.websearch ?? config.codingAgents.websearch,
    permissionMode: options.permissionMode,
    cwd: executionCwd || io.cwd,
    options,
    env: runtimeEnv,
    diagnostics: io.stderr,
    eventSink,
    sessionState
  }); } catch (error) { await sessionState?.close(); throw error; }
  if (sessionState) eventSink({ type: 'session-ready', sessionId: options.sessionId });
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    runtime.cancel('SIGINT');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
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
      const result = options.controlStdin
        ? await runControlledExecution(runtime, initialPrompt, {
          input: io.stdin, eventSink, signal: controller.signal, instruction: initialInstruction
        })
        : await runtime.execute(initialPrompt, { signal: controller.signal, instruction: initialInstruction });
      const outputPath = options.output ? resolve(io.cwd, options.output) : null;
      await writeResult(result, { outputPath, force: options.force, stdout: io.stdout });
    }
    return EXIT_CODES.success;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try { await runtime.close(); } finally { await sessionState?.close(); }
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
    if (options.command === 'agent') return await runAgentCommand(options, io, env);
    return await runExecution(options, io, env);
  } catch (error) {
    const alaError = asALAError(error);
    stderr.write(`ala: ${alaError.message}\n`);
    return alaError.exitCode;
  }
}
