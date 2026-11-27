// Pi keeps its interactive conversations under `.pi/agent/sessions/--<folder>--/<time>_<id>.jsonl`, where <folder>
// is the absolute folder without its leading separator and with every separator replaced by '-'. The first record
// is the `session` header with the conversation's folder. The executions ALA drives keep their sessions in the
// workspace's own `.ala-pi-sessions` directory, so they never appear here.
import path from 'node:path';

import {
  HEAD_BYTES, filesByRecency, jsonRecords, messageText, newestFirst, readSlice, requireSessionContext,
  requireSessionId, sessionLimit, sessionTitle, timestampOf
} from '../../native-sessions.mjs';

const SCAN_LIMIT = 400;

export function sessionDirectoryName(cwd) {
  return `--${cwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
}

function firstUserText(records) {
  for (const record of records) {
    if (record.type !== 'message' || record.message?.role !== 'user') continue;
    const text = messageText(record.message.content).trim();
    if (text) return text;
  }
  return '';
}

function sessionName(records) {
  let name = '';
  for (const record of records) {
    if (record.type === 'session_info' && typeof record.name === 'string') name = record.name;
  }
  return name;
}

async function readSession(entry, cwd, includeEmpty = false) {
  const head = jsonRecords(await readSlice(entry.file, HEAD_BYTES));
  const header = head[0];
  if (header?.type !== 'session' || typeof header.id !== 'string' || header.cwd !== cwd) return null;
  const firstText = firstUserText(head);
  const tail = jsonRecords(await readSlice(entry.file, HEAD_BYTES, { fromEnd: true }));
  const name = sessionName(tail) || sessionName(head);
  if (!name && !firstText && !includeEmpty) return null;
  return {
    id: header.id,
    title: sessionTitle(name || firstText) || 'Untitled conversation',
    createdAt: timestampOf(header.timestamp, entry.birthtimeMs || entry.mtimeMs),
    updatedAt: Math.trunc(entry.mtimeMs)
  };
}

export async function listInteractiveSessions(options = {}) {
  const { home, cwd } = requireSessionContext(options);
  const directory = path.join(home, '.pi', 'agent', 'sessions', sessionDirectoryName(cwd));
  const files = (await filesByRecency(directory, (name) => name.endsWith('.jsonl'))).slice(0, options.all === true ? undefined : SCAN_LIMIT);
  const sessions = [];
  for (const entry of files) {
    const session = await readSession(entry, cwd, options.all === true).catch(() => null);
    if (session) sessions.push(session);
  }
  return newestFirst(sessions, (options.all === true ? Number.MAX_SAFE_INTEGER : sessionLimit(options.limit)));
}

export function interactiveArguments({ resume = null } = {}) {
  return resume ? ['--session', requireSessionId(resume)] : [];
}

export const presetSessionId = false;
