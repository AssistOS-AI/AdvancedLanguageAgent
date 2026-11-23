// The Antigravity CLI keeps its conversations in `.gemini/antigravity-cli/conversations/<id>.db` and a catalog of
// them in `.gemini/antigravity-cli/conversation_summaries.db`, whose `workspace_uris` names each conversation's folder
// as `file://` URIs. Its interactive interface also appends every typed prompt to `.gemini/antigravity-cli/
// history.jsonl` as `{display, workspace, conversationId}`, except the first prompt of a conversation, written before
// the conversation exists; and it gives every conversation a generated title. Print-mode runs, which is how ALA drives
// agy, do neither. So a conversation is interactive when the history names it or it has a title, and it belongs to a
// folder when the catalog or the history records that folder. A conversation whose process was killed stays in agy's store and is offered like any
// other. The database is opened read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  jsonRecords, newestFirst, readSlice, requireSessionContext, requireSessionId, sessionLimit, sessionTitle, timestampOf
} from '../../native-sessions.mjs';

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// The most recent part of the prompt history; older conversations fall out of it as the history grows.
const HISTORY_BYTES = 8 * 1024 * 1024;
const QUERY = `select conversation_id, title, preview, workspace_uris, parent_conversation_id, last_modified_time
  from conversation_summaries`;

async function openDatabase(file) {
  const metadata = await fs.lstat(file);
  if (!metadata.isFile()) throw Object.assign(new Error('not a database'), { code: 'ENOENT' });
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

// The folders the interactive history records for each conversation it names.
async function interactiveConversations(root) {
  const history = path.join(root, 'history.jsonl');
  const metadata = await fs.lstat(history).catch(() => null);
  if (!metadata?.isFile()) return new Map();
  const folders = new Map();
  for (const record of jsonRecords(await readSlice(history, HISTORY_BYTES, { fromEnd: true }))) {
    if (typeof record.conversationId !== 'string' || !CONVERSATION_ID.test(record.conversationId)) continue;
    const known = folders.get(record.conversationId) || new Set();
    if (typeof record.workspace === 'string' && path.isAbsolute(record.workspace)) known.add(path.resolve(record.workspace));
    folders.set(record.conversationId, known);
  }
  return folders;
}

function workspaceFolders(value) {
  let uris;
  try { uris = JSON.parse(value || '[]'); } catch { return []; }
  if (!Array.isArray(uris)) return [];
  return uris.flatMap((uri) => {
    try { return [path.resolve(fileURLToPath(uri))]; } catch { return []; }
  });
}

// "2026-11-23 10:15:38.581277326+00:00" as epoch milliseconds.
function modifiedAt(value) {
  return timestampOf(String(value || '').replace(' ', 'T').replace(/(\.\d{3})\d+/u, '$1'));
}

export async function listInteractiveSessions(options = {}, { open = openDatabase } = {}) {
  const { home, cwd } = requireSessionContext(options);
  const root = path.join(home, '.gemini', 'antigravity-cli');
  const history = await interactiveConversations(root);
  let database;
  try {
    database = await open(path.join(root, 'conversation_summaries.db'));
  } catch (error) {
    if (error?.code === 'ENOENT' || /unable to open|SQLITE_CANTOPEN/iu.test(String(error?.message))) return [];
    throw error;
  }
  try {
    const sessions = [];
    for (const row of database.prepare(QUERY).all()) {
      const id = row.conversation_id;
      if (typeof id !== 'string' || !CONVERSATION_ID.test(id) || row.parent_conversation_id) continue;
      if (!history.has(id) && !String(row.title || '').trim()) continue;
      if (!workspaceFolders(row.workspace_uris).includes(cwd) && !history.get(id)?.has(cwd)) continue;
      const title = sessionTitle(row.title || row.preview);
      if (!title) continue;
      const updatedAt = modifiedAt(row.last_modified_time);
      sessions.push({ id, title, createdAt: updatedAt, updatedAt });
    }
    return newestFirst(sessions, sessionLimit(options.limit));
  } finally {
    database.close();
  }
}

export function interactiveArguments({ resume = null } = {}) {
  return resume ? ['--conversation', requireSessionId(resume)] : [];
}

export const presetSessionId = false;
