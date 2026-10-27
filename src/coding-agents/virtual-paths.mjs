import path from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { ROBOT_HOME } from './provider.mjs';

// Embedded ALA never canonicalizes a workload path in its own filesystem. HOME, the working directory, folders and
// exclusions are virtual paths: normalized absolute POSIX paths that only the provider resolves.

export const MAX_VIRTUAL_PATH = 4096;

// The same rule validates the paths the caller supplies and the paths a provider returns, which are untrusted text:
// no control characters and a bounded length.
export function virtualPathProblem(value) {
  if (typeof value !== 'string' || value === '') return 'must be a nonempty string';
  if (value.length > MAX_VIRTUAL_PATH) return `must not exceed ${MAX_VIRTUAL_PATH} characters`;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return 'must not contain control characters';
  if (!value.startsWith('/')) return 'must be an absolute path';
  if (path.posix.normalize(value) !== value || (value.length > 1 && value.endsWith('/'))
      || value.split('/').includes('..')) return 'must be normalized and free of "..", "." and empty segments';
  return null;
}

export function isVirtualPath(value) {
  return virtualPathProblem(value) === null;
}

const within = (child, parent) => child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);

export function requireVirtualPath(value, label, exitCode = EXIT_CODES.usage) {
  const problem = virtualPathProblem(value);
  if (problem) throw new ALAError(`${label} ${problem}.`, exitCode);
  return value;
}

// The only HOME an embedded execution may name is the provider's robot HOME.
export function resolveVirtualHome(value) {
  if (value === undefined || value === null) return ROBOT_HOME;
  requireVirtualPath(value, '--home');
  if (value !== ROBOT_HOME) {
    throw new ALAError(`--home must be ${ROBOT_HOME} when an execution provider owns HOME.`, EXIT_CODES.usage);
  }
  return value;
}

// Folders are virtual paths with read or write access. The mount shape matches resolveFolderMounts (source and
// target are the same virtual path), so the rest of the service treats both modes alike. Aliases and explicit
// destinations name Bubblewrap mount layout and do not exist here; the provider mounts fixed workload paths itself.
export function resolveVirtualFolders(folders = [], { cwd = null, home = ROBOT_HOME } = {}) {
  if (!Array.isArray(folders)) throw new ALAError('--folder must be a list of virtual paths.', EXIT_CODES.usage);
  const result = [];
  for (const folder of folders) {
    if (folder?.alias !== undefined || folder?.target !== undefined || folder?.expose !== undefined) {
      throw new ALAError('--folder as, at and expose are not available when an execution provider owns the mounts.',
        EXIT_CODES.usage);
    }
    const source = requireVirtualPath(folder?.source, '--folder');
    if (source === '/' || within(source, home) || within(home, source)) {
      throw new ALAError(`--folder conflicts with the robot HOME: ${source}`, EXIT_CODES.usage);
    }
    // As in standalone mode a read-only ancestor may contain the writable cwd; only a duplicate is refused.
    if (source === cwd) throw new ALAError('A mounted folder duplicates the working directory.', EXIT_CODES.usage);
    if (result.some((entry) => within(source, entry.target) || within(entry.target, source))) {
      throw new ALAError(`--folder destinations overlap: ${source}`, EXIT_CODES.usage);
    }
    result.push({ source, target: source, writable: Boolean(folder.writable) });
  }
  return result;
}

// Exclusions are paths that must be absent in the workload view; the provider adds them to its own mandatory list.
export function resolveVirtualExclusions(paths = []) {
  return paths.map((entry) => requireVirtualPath(entry, '--ignore'));
}
