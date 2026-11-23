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

// The value of one variable in a dotenv file (`NAME=value`, optionally `export NAME=value` and quoted), or ''.
// The same bounds as readJson apply: only a bounded regular file is read, and a link is not followed.
export async function readDotenvValue(file, name) {
  let text;
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.size > FILE_LIMIT) return '';
    text = await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
  let value = '';
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || match[1] !== name) continue;
    const raw = match[2];
    const quoted = /^(['"])(.*)\1$/u.exec(raw);
    // A later assignment wins, as in python-dotenv.
    value = quoted ? quoted[2] : raw.replace(/\s+#.*$/u, '');
  }
  return value.trim();
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
