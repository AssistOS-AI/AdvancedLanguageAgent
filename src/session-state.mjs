import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readTranscriptRecords, sessionTranscriptPath } from './transcript.mjs';

async function processIdentity(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

// Resolve the directory that owns ALA session transcripts: ALA_SESSIONS when
// set, otherwise <cwd>/.ala.
export function resolveSessionsRoot({ env = process.env, cwd }) {
  const configured = String(env.ALA_SESSIONS || '').trim();
  return configured ? path.resolve(cwd, configured) : path.join(cwd, '.ala');
}

async function acquireLock(lock) {
  const owner = { host: os.hostname(), pid: process.pid, start: await processIdentity(process.pid), token: randomUUID() };
  try { await fs.writeFile(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); return; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
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
    // A process on another host or container cannot be probed through /proc.
    if (previous.host && previous.host !== owner.host) throw new Error(`ALA session is locked by host ${previous.host}.`);
    try {
      if (await processIdentity(pid) === previous.start) throw new Error('ALA session is already running.');
    } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
    await fs.unlink(lock);
    await fs.writeFile(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  } finally { await fs.unlink(recovery); }
}

// One append-only JSONL transcript per session. Every line is written once;
// the native continuation is the last `continuation` record.
export async function openSessionState({ id, sessionsRoot, resume = false }) {
  if (!/^[0-9a-f-]{36}$/u.test(id) || !sessionsRoot) {
    throw new Error('Persistent sessions require a UUID and a sessions directory.');
  }
  const root = path.join(sessionsRoot, 'sessions');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = sessionTranscriptPath(sessionsRoot, id);
  const lock = `${file}.lock`;
  await acquireLock(lock);
  try {
    const record = { id, agent: null, continuation: null };
    let seq = 0;
    if (resume) {
      const records = await readTranscriptRecords(file);
      if (records[0]?.type !== 'session' || records[0].id !== id) throw new Error('ALA session transcript is invalid.');
      for (const entry of records) if (entry.type === 'continuation') Object.assign(record, { agent: entry.agent, continuation: entry.continuation });
      seq = records.at(-1).seq;
      if (!record.agent || !record.continuation) throw new Error('ALA session cannot be resumed: it has no native continuation.');
    } else {
      let records = null;
      try { records = await readTranscriptRecords(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (records) {
        // A transcript without native continuation (the first turn failed before
        // the coding agent started) is continued; one with continuation must be resumed.
        if (records[0]?.type !== 'session' || records[0].id !== id) throw new Error('ALA session transcript is invalid.');
        if (records.some((entry) => entry.type === 'continuation' && entry.continuation)) {
          throw new Error('ALA session already has a native conversation; use --resume-session.');
        }
        for (const entry of records) if (entry.type === 'continuation') record.agent = entry.agent;
        seq = records.at(-1).seq;
      } else {
        seq = 1;
        await fs.writeFile(file, `${JSON.stringify({ seq, type: 'session', at: new Date().toISOString(), id })}\n`, { flag: 'wx', mode: 0o600 });
      }
    }
    let writes = Promise.resolve();
    const append = (type, fields = {}) => {
      seq += 1;
      const line = `${JSON.stringify({ seq, type, at: new Date().toISOString(), ...fields })}\n`;
      writes = writes.then(() => fs.appendFile(file, line, { mode: 0o600 }));
      return writes;
    };
    return {
      record,
      file,
      append,
      save(update) {
        const next = { agent: update.agent ?? record.agent, continuation: update.continuation ?? record.continuation };
        if (next.agent === record.agent && JSON.stringify(next.continuation) === JSON.stringify(record.continuation)) return writes;
        Object.assign(record, next);
        return append('continuation', { agent: record.agent, continuation: record.continuation });
      },
      async close() { try { await writes; } finally { await fs.unlink(lock); } }
    };
  } catch (error) { await fs.unlink(lock); throw error; }
}
