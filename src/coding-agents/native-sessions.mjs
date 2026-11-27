// Read-only helpers for the native session catalogs of interactive coding agents. A coding agent's `sessions`
// module lists the conversations a person started interactively in one folder, so a caller can offer them for
// resumption, and returns the native arguments that open a new or resumed conversation.
// Persistent index imports use all:true to include untitled native records and bypass
// recent-menu scan and result limits. Default menu behavior remains bounded.
//
// Every session module exports:
//   listInteractiveSessions({ home, cwd, limit, all })  [{ id, title, createdAt, updatedAt }], newest first
//   interactiveArguments({ resume, sessionId })      native arguments for the interactive binary
//
// `home` is the home directory the agent runs with, `cwd` the absolute folder of the conversation. Only
// conversations started by a person in the agent's own interactive interface are listed; executions that ALA
// drives headlessly are left out. Nothing is written, and a missing or unreadable catalog lists nothing.
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SESSION_LIMIT = 50;
export const MAX_SESSION_LIMIT = 200;
export const HEAD_BYTES = 256 * 1024;
const TITLE_LENGTH = 80;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function sessionLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_SESSION_LIMIT) : DEFAULT_SESSION_LIMIT;
}

export function requireSessionContext({ home, cwd } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('A session catalog needs an absolute home.');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('A session catalog needs an absolute folder.');
  return { home: path.resolve(home), cwd: path.resolve(cwd) };
}

export function requireSessionId(value, label = 'session') {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new TypeError(`Invalid ${label} identifier.`);
  return value;
}

// One display line from free text: control characters and runs of whitespace collapse to single spaces.
export function sessionTitle(text) {
  const line = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

// The first `bytes` of a file, or its last `bytes` with `fromEnd`. A missing file reads as ''.
export async function readSlice(file, bytes, { fromEnd = false } = {}) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, fromEnd ? size - length : 0);
    return buffer.toString('utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return '';
    throw error;
  } finally {
    await handle?.close();
  }
}

// The complete JSON records of a slice of a JSONL file; a line cut by the slice boundary is skipped.
export function jsonRecords(text) {
  const records = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue;
    try { records.push(JSON.parse(line)); } catch { /* a cut or foreign line */ }
  }
  return records;
}

// The regular files of a directory with their modification times, newest first.
export async function filesByRecency(directory, accept) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !accept(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat) files.push({ name: entry.name, file, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export function timestampOf(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : Math.trunc(fallback);
}

export function newestFirst(sessions, limit) {
  return sessions.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

// The text of a user message whose content is a string or an array of text parts.
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join(' ');
}
