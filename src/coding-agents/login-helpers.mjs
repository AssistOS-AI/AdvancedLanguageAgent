import fs from 'node:fs/promises';

const FILE_LIMIT = 4 * 1024 * 1024;

export const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const filled = (value) => (typeof value === 'string' && value.trim() !== '')
  || (isRecord(value) && Object.keys(value).length > 0);

// The login state may live in a directory another user controls, so only a bounded regular file is
// opened; a FIFO would block and a symbolic link is not followed.
export async function readJson(file) {
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.size > FILE_LIMIT) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function openSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch {
    // Node.js before 22.5 has no built-in SQLite; such a database then counts as no login.
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

// Runs query(database, tables) on a read-only database; an unreadable database is no login.
export async function queryLoginDatabase(file, query) {
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile()) return false;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sibling = await fs.lstat(file + suffix).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (sibling && !sibling.isFile()) return false;
    }
    const DatabaseSync = await openSqlite();
    if (!DatabaseSync) return false;
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => row.name));
      return query(database, tables);
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}
