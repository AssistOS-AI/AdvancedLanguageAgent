import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const AGENT_NAMES = Object.freeze(['codex', 'opencode', 'pi']);
export const DEFAULT_AGENT_PRIORITY = Object.freeze([...AGENT_NAMES]);

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
    return await executable(resolved) ? resolved : null;
  }
  for (const directory of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const resolved = resolve(directory, candidate);
    if (await executable(resolved)) return resolved;
  }
  return null;
}

export function normalizeAgentPriority(value, fallback = DEFAULT_AGENT_PRIORITY) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  const result = [];
  for (const entry of entries) {
    const name = String(entry).trim().toLowerCase();
    if (AGENT_NAMES.includes(name) && !result.includes(name)) result.push(name);
  }
  for (const name of fallback) if (!result.includes(name)) result.push(name);
  return result;
}

export async function discoverCodingAgents({ env = process.env, priority = DEFAULT_AGENT_PRIORITY } = {}) {
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
  const order = normalizeAgentPriority(env.ALA_CODING_AGENT_PRIORITY || priority);
  return records.sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name));
}
