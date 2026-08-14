import { readFile } from 'node:fs/promises';
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
import { writeResult } from './output.mjs';
import { validateTaskRepository } from './repositories.mjs';
import { createRuntime, feedbackPrompt } from './runtime.mjs';
import { discoverCodingAgents } from './coding-agents/discovery.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function packageVersion() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

async function runRepositoryCommand(options, io, env) {
  if (options.help) {
    io.stdout.write(`${HELP_TEXT}\n`);
    return EXIT_CODES.success;
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
    const repositoryPath = await canonicalRepositoryPath(options.target, io.cwd);
    await validateTaskRepository(repositoryPath);
    if (!config.taskRepositories.some((entry) => entry.path === repositoryPath)) {
      config.taskRepositories.push({ path: repositoryPath });
      await saveConfig(configPath, config);
    }
    io.stdout.write(`${repositoryPath}\n`);
    return EXIT_CODES.success;
  }

  const lexicalPath = resolve(io.cwd, options.target);
  let canonicalPath = lexicalPath;
  try { canonicalPath = await canonicalRepositoryPath(options.target, io.cwd); } catch {}
  const index = config.taskRepositories.findIndex(
    (entry) => entry.path === canonicalPath || entry.path === lexicalPath
  );
  if (index === -1) throw new ALAError(`Task repository is not registered: ${options.target}`, EXIT_CODES.repository);
  const [removed] = config.taskRepositories.splice(index, 1);
  await saveConfig(configPath, config);
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

async function interactiveLoop(runtime, initialPrompt, initialInstruction, options, io, signal) {
  const readline = createInterface({
    input: io.stdin,
    output: io.stderr,
    terminal: Boolean(io.stdin.isTTY)
  });
  let previousResult = null;
  const slashHelp = 'Interactive commands: /agent list | /agent auto <prompt> | /agent codex <prompt> | /agent opencode <prompt> | /agent pi <prompt> | /symbolic detection on|off | /quit | /exit';
  try {
    if (initialPrompt) {
      previousResult = await runtime.execute(initialPrompt, { signal, instruction: initialInstruction });
      await writeResult(previousResult, { stdout: io.stdout });
    }
    const handleLine = async (rawLine) => {
      const line = String(rawLine).trim();
      if (!line) return false;
      if (line === ':quit' || line === ':exit' || line === '/quit' || line === '/exit') return true;
      if (line.startsWith('/')) {
        try {
          const parts = line.split(/\s+/u);
          if (parts[0] === '/agent') {
            const action = parts[1] || 'help';
            if (action === 'help') {
              io.stderr.write(`${slashHelp}\n`);
            } else if (action === 'list') {
              const names = runtime.listCodingAgents();
              io.stdout.write(names.map((name) => `${name}\n`).join(''));
            } else if (['auto', 'codex', 'opencode', 'pi'].includes(action)) {
              const prompt = parts.slice(2).join(' ').trim();
              if (!prompt) throw new ALAError(`/agent ${action} requires a prompt.`, EXIT_CODES.usage);
              const result = await runtime.executeAgent(prompt, { agent: action, signal });
              await writeResult(result, { stdout: io.stdout });
            } else {
              throw new ALAError(`Unknown interactive command: ${line}`, EXIT_CODES.usage);
            }
          } else if (parts[0] === '/symbolic') {
            if (parts[1] !== 'detection' || !['on', 'off'].includes(parts[2])) {
              throw new ALAError('Usage: /symbolic detection on|off', EXIT_CODES.usage);
            }
            runtime.setSymbolicDetection(parts[2] === 'on');
            io.stderr.write(`ala: symbolic detection ${parts[2]}\n`);
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
      previousResult = await runtime.execute(prompt, { signal });
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
  const repositories = await resolveActiveRepositories({
    config,
    env,
    temporary: options.taskRepositories,
    cwd: io.cwd
  });
  const achilles = await loadAchillesAgentLib({
    overridePath: options.achillesPath,
    env,
    cwd: io.cwd
  });
  const codingAgents = await discoverCodingAgents({ env, priority: config.codingAgents.priority });
  if (options.agent) {
    const available = codingAgents.filter((agent) => agent.available);
    const selected = options.agent === 'auto'
      ? available[0]
      : available.find((agent) => agent.name === options.agent);
    if (!selected) throw new ALAError(`Coding agent is not available: ${options.agent}`, EXIT_CODES.execution);
  }
  const runtime = await createRuntime({
    achillesModule: achilles.module,
    repositories,
    codingAgents,
    options,
    env,
    diagnostics: io.stderr
  });
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    runtime.cancel('SIGINT');
  };
  process.once('SIGINT', interrupt);

  try {
    const inferredInteractive = options.interactive || (options.instructionParts.length === 0 && io.stdin.isTTY);
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
    if (inferredInteractive) await interactiveLoop(runtime, initialPrompt, initialInstruction, options, io, controller.signal);
    else {
      const result = await runtime.execute(initialPrompt, { signal: controller.signal, instruction: initialInstruction });
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
