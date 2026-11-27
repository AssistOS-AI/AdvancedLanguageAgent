// Mistral Vibe keeps each conversation in `.vibe/logs/session/unified/<session id>/`. Its `meta.json` names the
// session, its working folder, its title once Vibe generated one, and whether it is a subagent's child session or
// archived. The history entries live in content-addressed `chunks/*.json` arrays; the first user message there is
// the fallback title. The executions ALA drives keep their sessions in the workspace's own `.ala-vibe-sessions`
// folder, so they never appear here.
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  HEAD_BYTES, messageText, newestFirst, readSlice, requireSessionContext, requireSessionId, sessionLimit,
  sessionTitle, timestampOf
} from '../../native-sessions.mjs';

const SCAN_LIMIT = 400;
const CHUNK_LIMIT = 64;
const META_BYTES = 64 * 1024;

async function sessionDirectories(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return [];
    throw error;
  }
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const stat = await fs.stat(path.join(directory, 'meta.json')).catch(() => null);
    if (stat?.isFile()) directories.push({ id: entry.name, directory, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
  }
  return directories.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, SCAN_LIMIT);
}

// The earliest user message among the session's history chunks.
async function firstUserText(directory) {
  let names;
  try {
    names = (await fs.readdir(path.join(directory, 'chunks'))).filter((name) => name.endsWith('.json')).slice(0, CHUNK_LIMIT);
  } catch {
    return '';
  }
  let first = null;
  for (const name of names) {
    let entries;
    try { entries = JSON.parse(await readSlice(path.join(directory, 'chunks', name), HEAD_BYTES)); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry?.type !== 'message' || entry.role !== 'user' || !Number.isFinite(entry.createdAt)) continue;
      const text = messageText(entry.content).trim();
      if (text && (!first || entry.createdAt < first.createdAt)) first = { createdAt: entry.createdAt, text };
    }
  }
  return first?.text || '';
}

// The native runtime snapshot contains the exact instruction configuration of this conversation.
// Never infer ownership from a title, a timestamp, or a PID in another PID namespace.
async function sessionBinding(directory) {
  try {
    const current = JSON.parse(await readSlice(path.join(directory, 'CURRENT'), META_BYTES));
    if (!/^[0-9]{16}$/u.test(current.generation)) return null;
    const state = JSON.parse(await readSlice(path.join(directory, 'generations', current.generation, 'runtime-state.json'), 8 * 1024 * 1024));
    const text = state.core_system_instructions;
    if (typeof text !== 'string') return null;
    const keys = [...text.matchAll(/^Session binding: ([a-f0-9-]{36})$/gmu)].map(match => match[1]);
    return keys.length === 1 ? keys[0] : null;
  } catch { return null; }
}

export const sessionBindingSupported = true;

async function readSession(entry, cwd) {
  const meta = JSON.parse(await readSlice(path.join(entry.directory, 'meta.json'), META_BYTES));
  const folder = meta?.environment?.working_directory || meta?.origin_directory;
  if (meta?.session_id !== entry.id || folder !== cwd || meta.parent_session_id || meta.archived_at) return null;
  const named = typeof meta.title === 'string' ? meta.title.trim() : '';
  const text = named || await firstUserText(entry.directory);
  const binding = await sessionBinding(entry.directory);
  if (!text && !binding) return null;
  return {
    id: entry.id,
    title: sessionTitle(text) || entry.id,
    sessionBinding: binding,
    createdAt: timestampOf(meta.start_time, entry.birthtimeMs || entry.mtimeMs),
    updatedAt: timestampOf(meta.bumped_at || meta.end_time, entry.mtimeMs)
  };
}

export async function listInteractiveSessions(options = {}) {
  const { home, cwd } = requireSessionContext(options);
  const sessions = [];
  for (const entry of await sessionDirectories(path.join(home, '.vibe', 'logs', 'session', 'unified'))) {
    const session = await readSession(entry, cwd).catch(() => null);
    if (session) sessions.push(session);
  }
  return newestFirst(sessions, sessionLimit(options.limit));
}

export function interactiveArguments({ resume = null } = {}) {
  return resume ? ['--resume', requireSessionId(resume)] : [];
}

export const presetSessionId = false;
