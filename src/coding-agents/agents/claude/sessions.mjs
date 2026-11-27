// Claude Code keeps one JSONL transcript per conversation under `.claude/projects/<folder>/<session id>.jsonl`,
// where <folder> is the absolute folder with every character outside [A-Za-z0-9] replaced by '-'. Interactive
// conversations record `entrypoint: "cli"`; the headless `-p` executions ALA drives record another entry point.
import path from 'node:path';

import {
  HEAD_BYTES, filesByRecency, jsonRecords, messageText, newestFirst, readSlice, requireSessionContext,
  requireSessionId, sessionLimit, sessionTitle, timestampOf
} from '../../native-sessions.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SCAN_LIMIT = 400;

export function projectDirectoryName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/gu, '-');
}

function firstUserText(records) {
  for (const record of records) {
    if (record.type !== 'user' || record.isMeta || record.isSidechain) continue;
    const text = messageText(record.message?.content).trim();
    if (text && !text.startsWith('<')) return text;
  }
  return '';
}

function lastTitle(records) {
  let custom = '';
  let generated = '';
  for (const record of records) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') custom = record.customTitle;
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') generated = record.aiTitle;
  }
  return custom || generated;
}

async function readSession(entry, cwd, includeEmpty = false) {
  const id = entry.name.slice(0, -'.jsonl'.length);
  if (!UUID.test(id)) return null;
  const head = jsonRecords(await readSlice(entry.file, HEAD_BYTES));
  const origin = head.find((record) => typeof record.entrypoint === 'string');
  if (origin?.entrypoint !== 'cli' || origin.cwd !== cwd) return null;
  const firstText = firstUserText(head);
  if (!firstText && !includeEmpty) return null;
  const tail = jsonRecords(await readSlice(entry.file, HEAD_BYTES, { fromEnd: true }));
  const title = lastTitle(tail) || lastTitle(head) || firstText;
  return {
    id,
    title: sessionTitle(title) || 'Untitled conversation',
    createdAt: timestampOf(origin.timestamp, entry.birthtimeMs || entry.mtimeMs),
    updatedAt: Math.trunc(entry.mtimeMs)
  };
}

export async function listInteractiveSessions(options = {}) {
  const { home, cwd } = requireSessionContext(options);
  const directory = path.join(home, '.claude', 'projects', projectDirectoryName(cwd));
  const files = (await filesByRecency(directory, (name) => name.endsWith('.jsonl'))).slice(0, options.all === true ? undefined : SCAN_LIMIT);
  const sessions = [];
  for (const entry of files) {
    const session = await readSession(entry, cwd, options.all === true);
    if (session) sessions.push(session);
  }
  return newestFirst(sessions, (options.all === true ? Number.MAX_SAFE_INTEGER : sessionLimit(options.limit)));
}

// A new conversation may be opened under an identifier chosen in advance, so a caller knows it from the start.
export function interactiveArguments({ resume = null, sessionId = null } = {}) {
  if (resume) return ['--resume', requireSessionId(resume)];
  if (sessionId) {
    if (!UUID.test(sessionId)) throw new TypeError('Claude Code session identifiers are UUIDs.');
    return ['--session-id', sessionId];
  }
  return [];
}

export const presetSessionId = true;
