import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function processIdentity(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

export async function openSessionState({ id, home, workspace, resume = false }) {
  if (!/^[0-9a-f-]{36}$/u.test(id) || !home || !workspace) {
    throw new Error('Persistent sessions require a UUID, --home and --cwd.');
  }
  const root = path.join(home, '.ala', 'sessions');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${id}.json`);
  const lock = `${file}.lock`;
  const owner = { pid: process.pid, start: await processIdentity(process.pid), token: randomUUID() };
  try { await fs.writeFile(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = `${lock}.recovery`;
    // Serialize stale-lock removal. Fresh contenders still compete through wx.
    // A crash during recovery fails closed instead of guessing which lock to remove.
    try { await fs.link(lock, recovery); }
    catch (claim) {
      if (claim.code === 'EEXIST') throw new Error(`ALA session lock recovery is already claimed: ${recovery}`);
      throw claim;
    }
    try {
      const previous = JSON.parse(await fs.readFile(lock, 'utf8'));
      const pid = previous.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid ALA session lock.');
      try {
        if (await processIdentity(pid) === previous.start) throw new Error('ALA session is already running.');
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      await fs.unlink(lock);
      await fs.writeFile(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    } finally { await fs.unlink(recovery); }
  }
  try {
    let record;
    if (resume) {
      record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (record.version !== 1 || record.id !== id || record.home !== home
          || record.workspace !== workspace || !record.agent || !record.continuation) {
        throw new Error('ALA session cannot be resumed with this home/workspace or has no native continuation.');
      }
    } else {
      record = { version: 1, id, home, workspace, agent: null, continuation: null };
      await fs.writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    }
    let writes = Promise.resolve();
    return {
      record,
      save(update) {
        Object.assign(record, update);
        const snapshot = JSON.stringify(record);
        writes = writes.then(async () => {
          const temporary = `${file}.${randomUUID()}.tmp`;
          await fs.writeFile(temporary, snapshot, { mode: 0o600 });
          await fs.rename(temporary, file);
        });
        return writes;
      },
      async close() { try { await writes; } finally { await fs.unlink(lock); } }
    };
  } catch (error) { await fs.unlink(lock); throw error; }
}
