import fs from 'node:fs';
import path from 'node:path';
import { ALAError, EXIT_CODES } from '../errors.mjs';
import { SANDBOX_HOME, SANDBOX_WORKSPACE } from './paths.mjs';

const invalid = message => new ALAError(`--folder ${message}`, EXIT_CODES.usage);
const within = (a, b) => a === b || a.startsWith(`${b}/`);
const overlaps = (a, b) => within(a, b) || within(b, a);
// O_PATH needs only search permission, like the bind it replaces. It has this value on the Linux architectures ALA runs on.
const O_PATH = process.platform === 'linux' ? 0o10000000 : 0;
const PIN_FLAGS = O_PATH | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const changed = source => new ALAError(`A granted directory changed or is unavailable: ${source}`, EXIT_CODES.directoryChanged);

// ALA mounts exactly what the caller supplies. Canonical hosts paths are
// mounted at their original absolute path; an optional alias mounts the same
// source at a fixed name under the sandbox workspace root to avoid collisions.
const reserved = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/dev', '/etc', SANDBOX_HOME,
  `${SANDBOX_WORKSPACE}/.agents`];

// An open descriptor keeps naming the directory it was opened on, whatever later happens to its path or any
// component above it. Comparing the opened directory with the identity the caller recorded when it checked the
// path also covers a swap made before this open.
export function pinDirectory(source, expected = null) {
  let fd;
  try {
    fd = fs.openSync(source, PIN_FLAGS);
    const stat = fs.fstatSync(fd, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}`;
    if (expected && identity !== expected) throw new Error('identity differs');
    return { fd, identity, source };
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw changed(source);
  }
}

export function parseExpectedDirectories(entries = []) {
  const expected = {};
  for (const entry of entries) {
    const match = /^(\d+:\d+):(\/.*)$/su.exec(entry);
    if (!match) throw new ALAError('--expect-dir requires <dev>:<ino>:<absolute-path>.', EXIT_CODES.usage);
    expected[path.resolve(match[2])] = match[1];
  }
  return expected;
}

export function pinFolderMounts(folders = [], cwd = process.cwd(), expected = {}) {
  return resolveFolderMounts(folders, cwd, expected).map((mount, index) => (mount.fd !== undefined ? mount : {
    ...mount, fd: pinDirectory(mount.source, expected[path.resolve(cwd, folders[index].source)]).fd
  }));
}

export function resolveFolderMounts(folders = [], cwd = process.cwd(), expected = {}) {
  if (!Array.isArray(folders)) throw invalid('must be a list of directories.');
  const result = [];
  for (const folder of folders) {
    if (!folder || typeof folder.source !== 'string' || !folder.source.trim()) throw invalid('requires a directory.');
    const requested = path.resolve(cwd, folder.source);
    // A pinned mount is never resolved again; its source records the checked name only.
    let source = folder.source;
    if (folder.fd === undefined) {
      try {
        source = fs.realpathSync(requested);
        if (!fs.statSync(source).isDirectory()) throw new Error();
      } catch { throw expected[requested] ? changed(requested) : invalid(`directory is unavailable: ${requested}`); }
    }
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
    const mount = { source, target, writable: Boolean(folder.writable), ...(folder.expose ? { expose: true } : {}),
      ...(folder.fd !== undefined ? { fd: folder.fd } : {}) };
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
