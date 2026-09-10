import fs from 'node:fs';
import path from 'node:path';
import { ALAError, EXIT_CODES } from '../errors.mjs';

const invalid = message => new ALAError(`--folder ${message}`, EXIT_CODES.usage);
const within = (a, b) => a === b || a.startsWith(`${b}/`);
const overlaps = (a, b) => within(a, b) || within(b, a);
const reserved = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/dev', '/etc', '/home', '/workspace/.agents'];

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
    const target = folder.alias !== undefined ? path.join('/workspace', folder.alias) : folder.target || requested;
    if (!path.isAbsolute(target) || path.normalize(target) !== target || target.includes('\0')
        || overlaps(target, '/workspace') && !within(target, '/workspace')
        || target === '/workspace' || reserved.some(entry => overlaps(target, entry))) {
      throw invalid(`destination conflicts with sandbox paths: ${target}`);
    }
    if (result.some(entry => overlaps(entry.target, target))) throw invalid(`destinations overlap: ${target}`);
    result.push({ source, target });
  }
  return result;
}

export function validateFolderTargets(folders, workspace, mounts) {
  for (const { target } of folders) {
    if (mounts.some(mount => overlaps(target, mount.target))) throw invalid(`destination conflicts with another mount: ${target}`);
    if (!within(target, '/workspace')) continue;
    let current = workspace;
    for (const part of path.relative('/workspace', target).split('/')) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid(`destination is not a plain directory: ${target}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
