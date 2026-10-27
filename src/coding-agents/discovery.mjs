import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const AGENT_NAMES = Object.freeze(['codex', 'opencode', 'pi', 'claude']);

const overrides = Object.freeze({ codex: 'CODEX_BIN', opencode: 'OPENCODE_BIN', pi: 'PI_BIN', claude: 'CLAUDE_BIN' });

function standardCandidates(name, env) {
  const home = env.HOME || homedir();
  if (name === 'opencode') return [join(home, '.opencode', 'bin', 'opencode')];
  return [join(home, '.local', 'bin', name)];
}

async function executable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCandidate(candidate, env) {
  if (!candidate) return null;
  if (isAbsolute(candidate) || candidate.includes('/')) {
    const resolved = resolve(candidate);
    return await executable(resolved) ? realpath(resolved) : null;
  }
  for (const directory of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const resolved = resolve(directory, candidate);
    if (await executable(resolved)) return realpath(resolved);
  }
  return null;
}

// Agents are reported in the fixed order codex, opencode, pi, claude; the first
// available one is used when no agent is requested or configured.
export async function discoverCodingAgents({ env = process.env } = {}) {
  const records = [];
  for (const name of AGENT_NAMES) {
    const candidates = [env[overrides[name]], ...standardCandidates(name, env), name].filter(Boolean);
    let binary = null;
    for (const candidate of candidates) {
      binary = await resolveCandidate(candidate, env);
      if (binary) break;
    }
    records.push({ name, available: Boolean(binary), binary });
  }
  return records;
}

// Embedded ALA has no tools of its own filesystem to search. It reports the backends of the provider's tool
// inventory in the same fixed order and refers to each one by name; the provider resolves the name.
export async function discoverProviderAgents(provider) {
  const inventory = await provider.inventory();
  return AGENT_NAMES.map((name) => {
    const entry = inventory.find((candidate) => candidate.name === name);
    return { name, available: Boolean(entry), binary: entry ? name : null,
      ...(entry?.version ? { version: entry.version } : {}) };
  });
}
