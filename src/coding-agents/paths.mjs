import path from 'node:path';
import { ALAError, EXIT_CODES } from '../errors.mjs';

export const SANDBOX_WORKSPACE = '/workspace';
export const SANDBOX_HOME = process.env.ALA_SANDBOX_HOME ?? '/home/ala';
if (!/^\/home\/[^/\s\0]+$/u.test(SANDBOX_HOME) || path.posix.normalize(SANDBOX_HOME) !== SANDBOX_HOME) {
  throw new ALAError('ALA_SANDBOX_HOME must be a normalized /home/<name> path.', EXIT_CODES.usage);
}

export function workspaceAliasTarget(alias) {
  if (alias === undefined) return null;
  if (typeof alias !== 'string' || !alias.trim() || ['.', '..'].includes(alias) || /[/\\\0]/u.test(alias)) {
    throw new ALAError('--cwd alias must be a single nonempty folder name.', EXIT_CODES.usage);
  }
  return `${SANDBOX_WORKSPACE}/${alias}`;
}
