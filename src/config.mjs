import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ALAError, EXIT_CODES } from './errors.mjs';

export const CONFIG_VERSION = 1;
const DEFAULT_CODING_AGENT_PRIORITY = ['codex', 'opencode', 'pi'];

export function resolveConfigPath({ cliPath, env = process.env, cwd = process.cwd(), homeDirectory = homedir() } = {}) {
  if (cliPath) return resolve(cwd, cliPath);
  const configuredRoot = String(env.ALA_CONFIG_PATH || '').trim();
  const environmentHome = String(env.HOME || '').trim();
  const configurationRoot = configuredRoot
    ? resolve(cwd, configuredRoot)
    : resolve(environmentHome || homeDirectory);
  return resolve(configurationRoot, '.ala', 'config.json');
}

function validateConfig(value, configPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ALAError(`ALA configuration must be a JSON object: ${configPath}`, EXIT_CODES.usage);
  }
  if (value.version !== CONFIG_VERSION) {
    throw new ALAError(`Unsupported ALA configuration version in ${configPath}.`, EXIT_CODES.usage);
  }
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
  const configuredModels = value.codingAgents?.models ?? {};
  if (!configuredModels || typeof configuredModels !== 'object' || Array.isArray(configuredModels)) {
    throw new ALAError(`codingAgents.models must be an object in ${configPath}.`, EXIT_CODES.usage);
  }
  const models = {};
  for (const [name, model] of Object.entries(configuredModels)) {
    if (!validNames.has(name) || typeof model !== 'string' || !model.trim()) {
      throw new ALAError(
        `codingAgents.models must map codex, opencode, or pi to non-empty model names in ${configPath}.`,
        EXIT_CODES.usage
      );
    }
    models[name] = model.trim();
  }
  const efforts = value.codingAgents?.efforts ?? {};
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts)
    || Object.entries(efforts).some(([name, effort]) => !validNames.has(name)
      || !models[name] || typeof effort !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(effort))) {
    throw new ALAError('codingAgents.efforts must map configured backends to native effort names.', EXIT_CODES.usage);
  }
  const websearch = value.codingAgents?.websearch ?? false;
  if (typeof websearch !== 'boolean') {
    throw new ALAError(`codingAgents.websearch must be a boolean in ${configPath}.`, EXIT_CODES.usage);
  }
  return { version: CONFIG_VERSION, codingAgents: { priority, models, efforts, websearch } };
}

export async function loadConfig(configPath) {
  try {
    const content = await readFile(configPath, 'utf8');
    return validateConfig(JSON.parse(content), configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        version: CONFIG_VERSION,
        codingAgents: { priority: [...DEFAULT_CODING_AGENT_PRIORITY], models: {}, efforts: {}, websearch: false }
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
