import { homedir } from 'node:os';
import path from 'node:path';

import { AGENT_NAMES, AGENTS, getAgent } from './registry.mjs';

// Whether each coding agent holds a login, found passively: a stored login is a credential file or
// database row where the agent's CLI keeps it, in the same state directories the sandbox mounts, and an
// environment login is an allowed credential variable that is set. Detection never runs a CLI, never
// contacts a provider, and never returns a credential value. A stored login may be expired or revoked.

function requireAgent(name) {
  const agent = getAgent(name);
  if (!agent) throw new TypeError(`Unknown coding agent: ${name}`);
  return agent;
}

// The directory where an agent keeps its login, taken from the state the sandbox mounts.
function stateDirectory(agent, env) {
  const state = agent.state(env, path.resolve(env.HOME || homedir()));
  return (state.find((entry) => entry.login) || state[0]).source;
}

// The environment an explicit agent home implies, as for executions with --home: every agent keeps its
// state under that home, whatever the caller's own state variables say.
export function homeEnvironment(env, home) {
  const root = path.resolve(home);
  return {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, '.config'),
    XDG_DATA_HOME: path.join(root, '.local', 'share'),
    XDG_CACHE_HOME: path.join(root, '.cache'),
    XDG_STATE_HOME: path.join(root, '.local', 'state'),
    ...Object.assign({}, ...AGENTS.map((agent) => agent.homeEnvironment(root)))
  };
}

// The files whose content decides an agent's stored login, so a caller can cache a result until one changes.
export function codingAgentLoginFiles(name, { env = process.env } = {}) {
  const agent = requireAgent(name);
  const directory = stateDirectory(agent, env);
  return agent.login.files.map((file) => path.join(directory, file));
}

// { loggedIn, file, env }: whether a stored login exists, and the names of the set credential variables.
export async function detectCodingAgentLogin(name, { env = process.env } = {}) {
  const agent = requireAgent(name);
  const file = await agent.login.detect(stateDirectory(agent, env));
  const variables = agent.sandbox.credentialEnv
    .filter((variable) => typeof env[variable] === 'string' && env[variable].trim() !== '');
  return { loggedIn: file || variables.length > 0, file, env: variables };
}

// The login of every agent, keyed by name in the fixed agent order.
export async function detectCodingAgentLogins({ env = process.env } = {}) {
  const entries = await Promise.all(AGENT_NAMES
    .map(async (name) => [name, await detectCodingAgentLogin(name, { env })]));
  return Object.fromEntries(entries);
}
