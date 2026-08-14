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

async function interactiveLoop(runtime, initialPrompt, options, io, signal) {
  const readline = createInterface({
    input: io.stdin,
    output: io.stderr,
    terminal: Boolean(io.stdin.isTTY)
  });
  let previousResult = null;
  try {
    if (initialPrompt) {
      previousResult = await runtime.execute(initialPrompt, { signal });
      await writeResult(previousResult, { stdout: io.stdout });
    }
    while (true) {
      const line = (await readline.question('ala> ')).trim();
      if (!line) continue;
      if (line === ':quit' || line === ':exit') break;
      const prompt = options.skill && previousResult !== null ? feedbackPrompt(previousResult, line) : line;
      previousResult = await runtime.execute(prompt, { signal });
      await writeResult(previousResult, { stdout: io.stdout });
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
  const runtime = await createRuntime({
    achillesModule: achilles.module,
    repositories,
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
    if (options.instructionParts.length > 0 || options.sources.length > 0 || !inferredInteractive) {
      const request = await loadRequest({
        instructionParts: options.instructionParts,
        sources: options.sources,
        stdin: io.stdin,
        cwd: io.cwd,
        fetchImpl: io.fetch
      });
      initialPrompt = composePrompt(request);
    }
    if (inferredInteractive) await interactiveLoop(runtime, initialPrompt, options, io, controller.signal);
    else {
      const result = await runtime.execute(initialPrompt, { signal: controller.signal });
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
    return options.command === 'repo'
      ? await runRepositoryCommand(options, io, env)
      : await runExecution(options, io, env);
  } catch (error) {
    const alaError = asALAError(error);
    stderr.write(`ala: ${alaError.message}\n`);
    return alaError.exitCode;
  }
}
