import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ALAError, EXIT_CODES } from './errors.mjs';

const AGENT_NAMES = new Set(['codex', 'opencode', 'pi']);
const CONFIG_FIELDS = new Set(['codingAgent', 'models', 'efforts']);

export function resolveConfigPath({ cliPath, env = process.env, cwd = process.cwd(), homeDirectory = homedir() } = {}) {
  if (cliPath) return resolve(cwd, cliPath);
  const configuredRoot = String(env.ALA_CONFIG_PATH || '').trim();
  const environmentHome = String(env.HOME || '').trim();
  const configurationRoot = configuredRoot
    ? resolve(cwd, configuredRoot)
    : resolve(environmentHome || homeDirectory);
  return resolve(configurationRoot, '.ala', 'config.json');
}

// The configuration holds the default coding agent and one model and effort
// per coding agent. Any other field is rejected rather than interpreted.
function validateConfig(value, configPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ALAError(`ALA configuration must be a JSON object: ${configPath}`, EXIT_CODES.usage);
  }
  const unknown = Object.keys(value).filter((key) => !CONFIG_FIELDS.has(key));
  if (unknown.length) {
    throw new ALAError(
      `ALA configuration supports only codingAgent, models and efforts; found ${unknown.join(', ')} in ${configPath}.`,
      EXIT_CODES.usage
    );
  }
  const codingAgent = value.codingAgent ?? null;
  if (codingAgent !== null && !AGENT_NAMES.has(codingAgent)) {
    throw new ALAError(`codingAgent must be codex, opencode, or pi in ${configPath}.`, EXIT_CODES.usage);
  }
  const configuredModels = value.models ?? {};
  if (!configuredModels || typeof configuredModels !== 'object' || Array.isArray(configuredModels)) {
    throw new ALAError(`models must be an object in ${configPath}.`, EXIT_CODES.usage);
  }
  const models = {};
  for (const [name, model] of Object.entries(configuredModels)) {
    if (!AGENT_NAMES.has(name) || typeof model !== 'string' || !model.trim()) {
      throw new ALAError(`models must map codex, opencode, or pi to non-empty model names in ${configPath}.`, EXIT_CODES.usage);
    }
    models[name] = model.trim();
  }
  const efforts = value.efforts ?? {};
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts)
    || Object.entries(efforts).some(([name, effort]) => !AGENT_NAMES.has(name)
      || !models[name] || typeof effort !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(effort))) {
    throw new ALAError(`efforts must map coding agents with a configured model to native effort names in ${configPath}.`, EXIT_CODES.usage);
  }
  return { ...(codingAgent ? { codingAgent } : {}), models, efforts: { ...efforts } };
}

export async function loadConfig(configPath) {
  try {
    const content = await readFile(configPath, 'utf8');
    return validateConfig(JSON.parse(content), configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { models: {}, efforts: {} };
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
