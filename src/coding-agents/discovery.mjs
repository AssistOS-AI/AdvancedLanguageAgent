import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

import { AGENTS } from './registry.mjs';

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

// Agents are reported in the fixed registry order.
export async function discoverCodingAgents({ env = process.env } = {}) {
  const records = [];
  for (const { name, binary: location } of AGENTS) {
    const candidates = [env[location.env], ...location.installPaths(env.HOME || homedir()), name].filter(Boolean);
    let binary = null;
    for (const candidate of candidates) {
      binary = await resolveCandidate(candidate, env);
      if (binary) break;
    }
    records.push({ name, available: Boolean(binary), binary });
  }
  return records;
}
