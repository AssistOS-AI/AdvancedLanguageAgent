import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const AGENT_NAMES = Object.freeze(['codex', 'opencode', 'pi']);

const overrides = Object.freeze({ codex: 'CODEX_BIN', opencode: 'OPENCODE_BIN', pi: 'PI_BIN' });

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

// Agents are reported in the fixed order codex, opencode, pi; the first
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
