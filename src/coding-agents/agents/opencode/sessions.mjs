// OpenCode keeps its conversations in the SQLite database `.local/share/opencode/opencode.db`. The database is
// opened read-only, so listing never runs OpenCode's migrations or changes its files. The conversations ALA
// drives are created with an explicit permission rule set; a conversation started in the interactive interface
// has none, and child conversations of a task have a parent.
import path from 'node:path';

import {
  newestFirst, requireSessionContext, requireSessionId, sessionLimit, sessionTitle, timestampOf
} from '../../native-sessions.mjs';

const QUERY = `select id, title, time_created, time_updated from session
  where directory = ? and parent_id is null and permission is null and time_archived is null
  order by time_updated desc limit ?`;

async function openDatabase(file) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

export async function listInteractiveSessions(options = {}, { open = openDatabase } = {}) {
  const { home, cwd } = requireSessionContext(options);
  const limit = (options.all === true ? Number.MAX_SAFE_INTEGER : sessionLimit(options.limit));
  let database;
  try {
    database = await open(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  } catch (error) {
    if (/unable to open|ENOENT|SQLITE_CANTOPEN/iu.test(String(error?.message || error?.code))) return [];
    throw error;
  }
  try {
    const v2 = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get();
    const rows = database.prepare(v2 ? QUERY.replace('from session', 'from session_v2') : QUERY).all(cwd, limit);
    return newestFirst(rows.filter((row) => typeof row.id === 'string' && row.id.startsWith('ses')).map((row) => ({
      id: row.id,
      title: sessionTitle(row.title) || row.id,
      createdAt: timestampOf(Number(row.time_created)),
      updatedAt: timestampOf(Number(row.time_updated))
    })), limit);
  } finally {
    database.close();
  }
}

export function interactiveArguments({ resume = null } = {}) {
  return resume ? ['--session', requireSessionId(resume)] : [];
}

export const presetSessionId = false;
