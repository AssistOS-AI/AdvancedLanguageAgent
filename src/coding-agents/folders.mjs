import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';

export const SANDBOX_WORKSPACE = '/workspace';
export const SANDBOX_FOLDERS_DIRECTORY = `${SANDBOX_WORKSPACE}/.ala/folders`;

function folderAlias(sourcePath) {
  const base = basename(sourcePath)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'folder';
  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  return `${base}-${hash}`;
}

export async function resolveFolderRequest(request, cwd = process.cwd()) {
  const requestedPath = String(request?.path || '').trim();
  if (!requestedPath) throw new ALAError('--folder requires a path.', EXIT_CODES.usage);
  let sourcePath;
  try {
    sourcePath = await realpath(resolve(cwd, requestedPath));
    if (!(await stat(sourcePath)).isDirectory()) {
      throw new Error('not a directory');
    }
    await access(sourcePath, constants.R_OK | constants.X_OK | (request.writable ? constants.W_OK : 0));
  } catch (error) {
    const accessMode = request.writable ? 'readable and writable' : 'readable';
    throw new ALAError(`Folder must be an accessible ${accessMode} directory: ${requestedPath}`, EXIT_CODES.input, {
      cause: error
    });
  }
  const alias = folderAlias(sourcePath);
  return Object.freeze({
    alias,
    sourcePath,
    workspacePath: `${SANDBOX_FOLDERS_DIRECTORY}/${alias}`,
    writable: Boolean(request.writable),
    access: request.writable ? 'read-write' : 'read-only'
  });
}

export function upsertFolder(records, record) {
  const index = records.findIndex((entry) => entry.sourcePath === record.sourcePath);
  if (index === -1) return [...records, record];
  const next = [...records];
  next[index] = record;
  return next;
}

export async function resolveFolderRequests(requests = [], cwd = process.cwd()) {
  let records = [];
  for (const request of requests) records = upsertFolder(records, await resolveFolderRequest(request, cwd));
  return records;
}

export async function removeFolderRecord(records, value, cwd = process.cwd()) {
  const requested = String(value || '').trim();
  if (!requested) throw new ALAError('/folder remove requires an alias or path.', EXIT_CODES.usage);
  let index = records.findIndex((entry) => entry.alias === requested || entry.sourcePath === requested);
  if (index === -1) {
    try {
      const canonical = await realpath(resolve(cwd, requested));
      index = records.findIndex((entry) => entry.sourcePath === canonical);
    } catch {
      // The stable alias and stored canonical path remain valid removal identifiers.
    }
  }
  if (index === -1) throw new ALAError(`Folder is not active: ${requested}`, EXIT_CODES.input);
  return records.filter((_, recordIndex) => recordIndex !== index);
}

