// Codex keeps one rollout per conversation under `.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. Its first
// record is `session_meta`, whose `originator` is `codex-tui` for the interactive interface; the app-server
// executions ALA drives carry ALA's client name. `.codex/session_index.jsonl` holds the conversation names.
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  HEAD_BYTES, jsonRecords, messageText, newestFirst, readSlice, requireSessionContext, requireSessionId,
  sessionLimit, sessionTitle, timestampOf
} from '../../native-sessions.mjs';

const INTERACTIVE_ORIGINATORS = new Set(['codex-tui', 'codex_cli_rs']);
const SCAN_LIMIT = 600;
const META_BYTES = 1024 * 1024;

async function directories(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map((entry) => entry.name).sort().reverse();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return [];
    throw error;
  }
}

// The rollouts, newest day first, bounded so that a long history is never read completely.
async function rollouts(root) {
  const files = [];
  for (const year of await directories(root)) {
    for (const month of await directories(path.join(root, year))) {
      for (const day of await directories(path.join(root, year, month))) {
        const directory = path.join(root, year, month, day);
        const names = (await fs.readdir(directory).catch(() => []))
          .filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl')).sort().reverse();
        for (const name of names) {
          files.push(path.join(directory, name));
          if (files.length >= SCAN_LIMIT) return files;
        }
      }
    }
  }
  return files;
}

async function threadNames(home) {
  const names = new Map();
  const text = await readSlice(path.join(home, '.codex', 'session_index.jsonl'), 8 * 1024 * 1024, { fromEnd: true });
  for (const record of jsonRecords(text)) {
    if (typeof record.id === 'string' && typeof record.thread_name === 'string') names.set(record.id, record.thread_name);
  }
  return names;
}

function firstUserText(records) {
  for (const record of records) {
    const payload = record.payload;
    if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') continue;
    const text = messageText(payload.content).trim();
    if (text && !text.startsWith('<')) return text;
  }
  return '';
}

async function readSession(file, cwd, names) {
  const head = await readSlice(file, META_BYTES);
  const newline = head.indexOf('\n');
  const [meta] = jsonRecords(newline === -1 ? head : head.slice(0, newline));
  const payload = meta?.type === 'session_meta' ? meta.payload : null;
  if (!payload || !INTERACTIVE_ORIGINATORS.has(payload.originator) || payload.cwd !== cwd) return null;
  if (payload.thread_source !== undefined && payload.thread_source !== 'user') return null;
  const id = typeof payload.id === 'string' ? payload.id : '';
  if (!id) return null;
  const firstText = firstUserText(jsonRecords(head.slice(0, HEAD_BYTES)));
  const name = names.get(id);
  if (!name && !firstText) return null;
  const stat = await fs.stat(file);
  return {
    id,
    title: sessionTitle(name || firstText),
    createdAt: timestampOf(payload.timestamp, stat.birthtimeMs || stat.mtimeMs),
    updatedAt: Math.trunc(stat.mtimeMs)
  };
}

export async function listInteractiveSessions(options = {}) {
  const { home, cwd } = requireSessionContext(options);
  const names = await threadNames(home);
  const sessions = [];
  for (const file of await rollouts(path.join(home, '.codex', 'sessions'))) {
    const session = await readSession(file, cwd, names).catch(() => null);
    if (session) sessions.push(session);
  }
  return newestFirst(sessions, sessionLimit(options.limit));
}

export function interactiveArguments({ resume = null } = {}) {
  return resume ? ['resume', requireSessionId(resume)] : [];
}

export const presetSessionId = false;
