import fs from 'node:fs';
import path from 'node:path';
import { ALAError, EXIT_CODES } from '../errors.mjs';
import { SANDBOX_WORKSPACE } from './paths.mjs';

const invalid = message => new ALAError(`--folder ${message}`, EXIT_CODES.usage);
const within = (a, b) => a === b || a.startsWith(`${b}/`);
const overlaps = (a, b) => within(a, b) || within(b, a);

// ALA mounts exactly what the caller supplies. Canonical hosts paths are
// mounted at their original absolute path; an optional alias mounts the same
// source at a fixed name under the sandbox workspace root to avoid collisions.
const reserved = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/dev', '/etc', '/home/ala',
  `${SANDBOX_WORKSPACE}/.agents`];

export function resolveFolderMounts(folders = [], cwd = process.cwd()) {
  if (!Array.isArray(folders)) throw invalid('must be a list of directories.');
  const result = [];
  for (const folder of folders) {
    if (!folder || typeof folder.source !== 'string' || !folder.source.trim()) throw invalid('requires a directory.');
    const requested = path.resolve(cwd, folder.source);
    let source;
    try {
      source = fs.realpathSync(requested);
      if (!fs.statSync(source).isDirectory()) throw new Error();
    } catch { throw invalid(`directory is unavailable: ${requested}`); }
    if (folder.alias !== undefined && (typeof folder.alias !== 'string' || !folder.alias.trim()
        || ['.', '..'].includes(folder.alias) || /[/\\\0]/u.test(folder.alias))) {
      throw invalid('alias must be a single nonempty folder name.');
    }
    // Honor an already-resolved destination so repeated resolution is
    // idempotent; the service resolves once and the sandbox re-resolves.
    if (folder.target !== undefined && (typeof folder.target !== 'string' || !path.isAbsolute(folder.target)
        || path.normalize(folder.target) !== folder.target)) {
      throw invalid('at requires a normalized absolute destination.');
    }
    if (folder.alias !== undefined && folder.target !== undefined) throw invalid('cannot combine as and at.');
    const target = folder.alias !== undefined ? path.join(SANDBOX_WORKSPACE, folder.alias)
      : folder.target !== undefined ? folder.target : requested;
    if (folder.expose !== undefined && typeof folder.expose !== 'boolean') throw invalid('expose must be a boolean.');
    if (folder.expose && (folder.writable || (folder.target === undefined && folder.alias === undefined))) {
      throw invalid('expose requires a read-only mount with an explicit destination.');
    }
    if (!path.isAbsolute(target) || path.normalize(target) !== target || target.includes('\0')
        || target === SANDBOX_WORKSPACE || (overlaps(target, SANDBOX_WORKSPACE) && !within(target, SANDBOX_WORKSPACE))
        || target === '/home' || reserved.some(entry => overlaps(target, entry))) {
      throw invalid(`destination conflicts with sandbox paths: ${target}`);
    }
    const mount = { source, target, writable: Boolean(folder.writable), ...(folder.expose ? { expose: true } : {}) };
    for (const entry of result) {
      if (!overlaps(entry.target, target)) continue;
      const child = within(target, entry.target) ? mount : entry;
      const parent = child === mount ? entry : mount;
      // Only an explicit read-only export may overlay a read-only ancestor.
      if (entry.target === target || !child.expose || parent.writable || child.writable) {
        throw invalid(`destinations overlap: ${target}`);
      }
    }
    result.push(mount);
  }
  return result;
}
