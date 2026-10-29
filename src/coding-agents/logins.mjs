import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { AGENT_NAMES } from './discovery.mjs';
import { CREDENTIAL_ENVIRONMENT } from './sandbox.mjs';

// Whether each coding agent holds a login, found passively: a stored login is a credential file or
// database row where the agent's CLI keeps it, in the same state directories the sandbox mounts, and an
// environment login is an allowed credential variable that is set. Detection never runs a CLI, never
// contacts a provider, and never returns a credential value. A stored login may be expired or revoked.

const FILE_LIMIT = 4 * 1024 * 1024;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const filled = (value) => (typeof value === 'string' && value.trim() !== '')
  || (isRecord(value) && Object.keys(value).length > 0);

// The directory where each agent keeps its state, resolved like the sandbox state mounts.
function stateDirectory(name, env) {
  const home = path.resolve(env.HOME || homedir());
  if (name === 'codex') return path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  if (name === 'opencode') {
    return path.join(path.resolve(env.XDG_DATA_HOME || path.join(home, '.local', 'share')), 'opencode');
  }
  if (name === 'pi') {
    return env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(home, '.pi', 'agent');
  }
  if (name === 'omp') return env.OMP_DIR ? path.resolve(env.OMP_DIR) : path.join(home, '.omp');
  if (name === 'claude') return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  throw new TypeError(`Unknown coding agent: ${name}`);
}

const LOGIN_FILES = Object.freeze({
  codex: ['auth.json'],
  opencode: ['auth.json', 'opencode.db', 'opencode.db-wal'],
  pi: ['auth.json'],
  omp: ['agent/agent.db', 'agent/agent.db-wal'],
  claude: ['.credentials.json', '.claude.json']
});

// The environment an explicit agent home implies, as for executions with --home: every agent keeps its
// state under that home, whatever the caller's own state variables say.
export function homeEnvironment(env, home) {
  const root = path.resolve(home);
  return {
    ...env,
    HOME: root,
    CODEX_HOME: path.join(root, '.codex'),
    XDG_CONFIG_HOME: path.join(root, '.config'),
    XDG_DATA_HOME: path.join(root, '.local', 'share'),
    XDG_CACHE_HOME: path.join(root, '.cache'),
    XDG_STATE_HOME: path.join(root, '.local', 'state'),
    PI_CODING_AGENT_DIR: path.join(root, '.pi', 'agent'),
    OMP_DIR: path.join(root, '.omp'),
    CLAUDE_CONFIG_DIR: path.join(root, '.claude')
  };
}

// The files whose content decides an agent's stored login, so a caller can cache a result until one changes.
export function codingAgentLoginFiles(name, { env = process.env } = {}) {
  const directory = stateDirectory(name, env);
  return LOGIN_FILES[name].map((file) => path.join(directory, file));
}

// The login state may live in a directory another user controls, so only a bounded regular file is
// opened; a FIFO would block and a symbolic link is not followed.
async function readJson(file) {
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.size > FILE_LIMIT) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// Codex keeps an API key, ChatGPT tokens, or another login mode's fields beside bookkeeping fields.
async function codexLogin(directory) {
  const auth = await readJson(path.join(directory, 'auth.json'));
  return isRecord(auth) && Object.entries(auth)
    .some(([key, value]) => !['last_refresh', 'auth_mode'].includes(key) && filled(value));
}

async function openSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch {
    // Node.js before 22.5 has no built-in SQLite; only auth.json is then inspected.
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

// OpenCode keeps Console accounts and connector credentials in its database; an unreadable database
// is no login.
async function openCodeDatabaseLogin(file) {
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile()) return false;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sibling = await fs.lstat(file + suffix).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (sibling && !sibling.isFile()) return false;
    }
    const DatabaseSync = await openSqlite();
    if (!DatabaseSync) return false;
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => row.name));
      const any = (table, where) => tables.has(table)
        && Boolean(database.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get());
      return any('account_state', 'active_account_id IS NOT NULL OR active_org_id IS NOT NULL')
        || any('control_account', 'active = 1') || any('credential', '1 = 1');
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

// OpenCode keeps provider keys and OAuth logins in auth.json.
async function openCodeLogin(directory) {
  const auth = await readJson(path.join(directory, 'auth.json'));
  const stored = isRecord(auth)
    && Object.values(auth).some((entry) => isRecord(entry) && typeof entry.type === 'string');
  if (stored) return true;
  return openCodeDatabaseLogin(path.join(directory, 'opencode.db'));
}

// Pi stores { type: 'api_key', key | env } or { type: 'oauth', access, refresh } per provider.
async function piLogin(directory) {
  const auth = await readJson(path.join(directory, 'auth.json'));
  return isRecord(auth) && Object.values(auth).some((entry) => isRecord(entry)
    && ((entry.type === 'api_key' && (filled(entry.key) || filled(entry.env)))
      || (entry.type === 'oauth' && filled(entry.access))));
}

// OMP keeps its logins as rows of agent/agent.db; a row that was disabled (for example after a revoked
// refresh token) is not a login, and an unreadable database is no login.
async function ompLogin(directory) {
  const file = path.join(directory, 'agent', 'agent.db');
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile()) return false;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sibling = await fs.lstat(file + suffix).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (sibling && !sibling.isFile()) return false;
    }
    const DatabaseSync = await openSqlite();
    if (!DatabaseSync) return false;
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => row.name));
      return tables.has('auth_credentials')
        && Boolean(database.prepare('SELECT 1 FROM auth_credentials WHERE disabled_cause IS NULL LIMIT 1').get());
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

// Claude Code keeps a subscription login in .credentials.json and an API key in .claude.json, both under
// CLAUDE_CONFIG_DIR, which the sandbox always sets.
async function claudeLogin(directory) {
  const credentials = await readJson(path.join(directory, '.credentials.json'));
  const oauth = credentials?.claudeAiOauth;
  if (isRecord(oauth) && (filled(oauth.accessToken) || filled(oauth.refreshToken))) return true;
  const config = await readJson(path.join(directory, '.claude.json'));
  return isRecord(config) && filled(config.primaryApiKey);
}

const DETECTORS = Object.freeze({ codex: codexLogin, opencode: openCodeLogin, pi: piLogin, omp: ompLogin, claude: claudeLogin });

// { loggedIn, file, env }: whether a stored login exists, and the names of the set credential variables.
export async function detectCodingAgentLogin(name, { env = process.env } = {}) {
  if (!DETECTORS[name]) throw new TypeError(`Unknown coding agent: ${name}`);
  const file = await DETECTORS[name](stateDirectory(name, env));
  const variables = CREDENTIAL_ENVIRONMENT[name]
    .filter((variable) => typeof env[variable] === 'string' && env[variable].trim() !== '');
  return { loggedIn: file || variables.length > 0, file, env: variables };
}

// The login of every agent, keyed by name in the fixed agent order.
export async function detectCodingAgentLogins({ env = process.env } = {}) {
  const entries = await Promise.all(AGENT_NAMES
    .map(async (name) => [name, await detectCodingAgentLogin(name, { env })]));
  return Object.fromEntries(entries);
}
