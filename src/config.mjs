import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ALAError, EXIT_CODES } from './errors.mjs';

export const CONFIG_VERSION = 1;
const DEFAULT_CODING_AGENT_PRIORITY = ['codex', 'opencode', 'pi'];

export function resolveConfigPath({ cliPath, env = process.env, cwd = process.cwd() } = {}) {
  if (cliPath) return resolve(cwd, cliPath);
  if (env.ALA_CONFIG_PATH) return resolve(cwd, env.ALA_CONFIG_PATH);
  const configRoot = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : resolve(homedir(), '.config');
  return resolve(configRoot, 'ala', 'config.json');
}

function validateConfig(value, configPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ALAError(`ALA configuration must be a JSON object: ${configPath}`, EXIT_CODES.usage);
  }
  if (value.version !== CONFIG_VERSION) {
    throw new ALAError(`Unsupported ALA configuration version in ${configPath}.`, EXIT_CODES.usage);
  }
  if (!Array.isArray(value.taskRepositories)) {
    throw new ALAError(`taskRepositories must be an array in ${configPath}.`, EXIT_CODES.usage);
  }
  const taskRepositories = value.taskRepositories.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) {
      throw new ALAError(`Every task repository must contain a non-empty path in ${configPath}.`, EXIT_CODES.usage);
    }
    return { path: entry.path };
  });
  const configuredPriority = value.codingAgents?.priority ?? DEFAULT_CODING_AGENT_PRIORITY;
  if (!Array.isArray(configuredPriority)) {
    throw new ALAError(`codingAgents.priority must be an array in ${configPath}.`, EXIT_CODES.usage);
  }
  const priority = configuredPriority.map((entry) => String(entry).trim().toLowerCase());
  const validNames = new Set(DEFAULT_CODING_AGENT_PRIORITY);
  if (priority.length === 0 || priority.some((entry) => !validNames.has(entry)) || new Set(priority).size !== priority.length) {
    throw new ALAError(
      `codingAgents.priority must contain unique codex, opencode, or pi values in ${configPath}.`,
      EXIT_CODES.usage
    );
  }
  for (const name of DEFAULT_CODING_AGENT_PRIORITY) if (!priority.includes(name)) priority.push(name);
  return { version: CONFIG_VERSION, taskRepositories, codingAgents: { priority } };
}

export async function loadConfig(configPath) {
  try {
    const content = await readFile(configPath, 'utf8');
    return validateConfig(JSON.parse(content), configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        version: CONFIG_VERSION,
        taskRepositories: [],
        codingAgents: { priority: [...DEFAULT_CODING_AGENT_PRIORITY] }
      };
    }
    if (error instanceof SyntaxError) {
      throw new ALAError(`ALA configuration is not valid JSON: ${configPath}`, EXIT_CODES.usage, { cause: error });
    }
    throw error;
  }
}

export async function saveConfig(configPath, config) {
  const validated = validateConfig(config, configPath);
  const parentDir = dirname(configPath);
  const temporaryPath = resolve(parentDir, `.config-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, configPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function canonicalRepositoryPath(candidate, cwd = process.cwd()) {
  const absolutePath = resolve(cwd, candidate);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    throw new ALAError(`Task repository does not exist: ${absolutePath}`, EXIT_CODES.repository, { cause: error });
  }
}

export function environmentRepositories(env = process.env) {
  if (!env.ALA_TASK_REPOSITORIES) return [];
  return env.ALA_TASK_REPOSITORIES.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
}

export async function resolveActiveRepositories({ config, env = process.env, temporary = [], cwd = process.cwd() }) {
  const candidates = [
    ...config.taskRepositories.map((entry) => entry.path),
    ...environmentRepositories(env),
    ...temporary
  ];
  const repositories = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const canonical = await canonicalRepositoryPath(candidate, cwd);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      repositories.push(canonical);
    }
  }
  return repositories;
}
