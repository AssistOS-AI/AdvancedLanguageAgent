import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig, resolveConfigPath } from './config.mjs';
import { ALAError, EXIT_CODES } from './errors.mjs';
import { discoverCodingAgents } from './coding-agents/discovery.mjs';
import { detectCodingAgentLogins, homeEnvironment } from './coding-agents/logins.mjs';

// `ala status` and interactive /status: which coding agents are installed, which hold a login, and which one
// an execution with --ca auto would use. Login detection is passive (see coding-agents/logins.mjs), so a
// reported login may still be expired or revoked, and no credential value is ever printed.

// The status of every agent in the fixed order. `agents` are discovery records when the caller already has
// them; `config` is the loaded ALA configuration.
export async function collectStatus({ env = process.env, config = {}, agents = null } = {}) {
  const records = agents || await discoverCodingAgents({ env });
  const logins = await detectCodingAgentLogins({ env });
  const configuredAgent = config.codingAgent || null;
  // The same choice as --ca auto outside a session: the configured agent when installed, else the first installed.
  const codingAgent = (records.find((record) => record.available && record.name === configuredAgent)
    || records.find((record) => record.available))?.name || null;
  return {
    codingAgent,
    configuredAgent,
    agents: records.map((record) => ({
      name: record.name,
      available: record.available,
      binary: record.binary || null,
      loggedIn: logins[record.name].loggedIn,
      login: { file: logins[record.name].file, env: logins[record.name].env }
    }))
  };
}

// One line per agent: its name, installation, login, and whether it is the default.
export function formatStatus(status) {
  return status.agents.map((agent) => {
    const sources = [agent.login.file ? 'credentials file' : null, ...agent.login.env].filter(Boolean);
    const login = agent.loggedIn ? `logged in (${sources.join(', ')})` : 'not logged in';
    const line = `${agent.name.padEnd(10)}${(agent.available ? 'available' : 'not installed').padEnd(15)}${login}`;
    return `${agent.name === status.codingAgent ? `${line}  default` : line}\n`;
  }).join('');
}

export async function runStatusCommand(options, io, env, helpText) {
  if (options.help) {
    io.stdout.write(`${helpText}\n`);
    return EXIT_CODES.success;
  }
  const home = options.home ? await realpath(resolve(io.cwd, options.home)) : null;
  if (home && !(await stat(home)).isDirectory()) {
    throw new ALAError('--home must reference an existing directory.', EXIT_CODES.usage);
  }
  const statusEnv = home ? homeEnvironment(env, home) : env;
  const config = await loadConfig(resolveConfigPath({ cliPath: options.configPath, env: statusEnv, cwd: io.cwd }));
  const status = await collectStatus({ env: statusEnv, config });
  io.stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
  return EXIT_CODES.success;
}
