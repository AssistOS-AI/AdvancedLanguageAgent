// OMP keeps its interactive conversations under `.omp/agent/sessions/<folder>/<time>_<id>.jsonl`. The folder name
// encodes the conversation's folder relative to the home or absolutely, so the catalog does not rely on it: it
// reads the `session` header of each recent file and compares its folder. The first record is a `title` record
// that OMP rewrites in place once it names the conversation. The executions ALA drives keep their sessions in the
// workspace's own `.ala-omp-sessions` directory, so they never appear here.
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  HEAD_BYTES, filesByRecency, jsonRecords, messageText, newestFirst, readSlice, requireSessionContext,
  requireSessionId, sessionLimit, sessionTitle, timestampOf
} from '../../native-sessions.mjs';

const SCAN_LIMIT = 400;
const HEADER_BYTES = 8 * 1024;

async function sessionFiles(root, all = false) {
  let directories;
  try {
    directories = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return [];
    throw error;
  }
  const files = [];
  for (const directory of directories) {
    files.push(...await filesByRecency(path.join(root, directory.name), (name) => name.endsWith('.jsonl')));
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, all ? undefined : SCAN_LIMIT);
}

function firstUserText(records) {
  for (const record of records) {
    if (record.type !== 'message' || record.message?.role !== 'user') continue;
    const text = messageText(record.message.content).trim();
    if (text) return text;
  }
  return '';
}

async function readSession(entry, cwd, includeEmpty = false) {
  const header = jsonRecords(await readSlice(entry.file, HEADER_BYTES)).find((record) => record.type === 'session');
  if (typeof header?.id !== 'string' || header.cwd !== cwd) return null;
  const head = jsonRecords(await readSlice(entry.file, HEAD_BYTES));
  const named = head.find((record) => record.type === 'title' && typeof record.title === 'string')?.title.trim();
  const firstText = firstUserText(head);
  if (!named && !firstText && !includeEmpty) return null;
  return {
    id: header.id,
    title: sessionTitle(named || firstText) || 'Untitled conversation',
    createdAt: timestampOf(header.timestamp, entry.birthtimeMs || entry.mtimeMs),
    updatedAt: Math.trunc(entry.mtimeMs)
  };
}

export async function listInteractiveSessions(options = {}) {
  const { home, cwd } = requireSessionContext(options);
  const sessions = [];
  for (const entry of await sessionFiles(path.join(home, '.omp', 'agent', 'sessions'), options.all === true)) {
    const session = await readSession(entry, cwd, options.all === true).catch(() => null);
    if (session) sessions.push(session);
  }
  return newestFirst(sessions, (options.all === true ? Number.MAX_SAFE_INTEGER : sessionLimit(options.limit)));
}

export function interactiveArguments({ resume = null } = {}) {
  return resume ? ['--resume', requireSessionId(resume)] : [];
}

export const presetSessionId = false;
