import fs from 'node:fs';
import path from 'node:path';

// Readers for the append-only session transcripts. Embedding applications
// import this module (package export "advanced-language-agent/transcript")
// instead of parsing the files themselves. Every reader is synchronous with an
// asynchronous alias, so callers with synchronous storage APIs can use them.

const SESSION_ID = /^[0-9a-f-]{36}$/u;
const SUMMARY_BYTES = 64 * 1024;

export function sessionTranscriptPath(sessionsRoot, id) {
  if (!SESSION_ID.test(String(id))) throw new Error('Invalid ALA session id.');
  return path.join(sessionsRoot, 'sessions', `${id}.jsonl`);
}

// Parse JSONL records. A trailing line without a newline is an interrupted
// append and is ignored; any other malformed line is an error.
function parseRecords(text, file) {
  // The element after the last newline is either empty or an unfinished append.
  return text.split('\n').slice(0, -1).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Malformed ALA transcript record ${index + 1}: ${file}`); }
  });
}

export function readTranscriptRecordsSync(file) {
  return parseRecords(fs.readFileSync(file, 'utf8'), file);
}

export async function readTranscriptRecords(file) {
  return parseRecords(await fs.promises.readFile(file, 'utf8'), file);
}

function emptyTurn(turnId, at) {
  return { turnId, startedAt: at, user: null, followUps: [], messages: [], tools: [], final: null,
    status: 'running', durationMs: null, error: null, endedAt: null, firstSeq: null, lastSeq: null };
}

// Fold transcript records into turns ordered by their first record.
export function foldTranscript(records) {
  const turns = new Map();
  let agent = null;
  let continuation = null;
  for (const record of records) {
    if (record.type === 'continuation') { agent = record.agent; continuation = record.continuation; continue; }
    if (!record.turnId) continue;
    if (!turns.has(record.turnId)) turns.set(record.turnId, emptyTurn(record.turnId, record.at));
    const turn = turns.get(record.turnId);
    turn.firstSeq ??= record.seq;
    turn.lastSeq = record.seq;
    if (record.type === 'user') {
      if (turn.user === null) turn.user = record.text;
      else turn.followUps.push({ seq: record.seq, at: record.at, text: record.text });
    } else if (record.type === 'agent-message') {
      turn.messages.push({ seq: record.seq, at: record.at, outputKind: record.outputKind, text: record.text,
        ...(record.outputId ? { outputId: record.outputId } : {}), ...(record.complete ? { complete: true } : {}) });
    } else if (record.type === 'tool') {
      turn.tools.push({ seq: record.seq, at: record.at, tool: record.tool, reason: record.reason });
    } else if (record.type === 'final') {
      turn.final = record.text;
    } else if (record.type === 'turn-end') {
      Object.assign(turn, { status: record.status, durationMs: record.durationMs ?? null,
        error: record.error || null, endedAt: record.at });
    }
  }
  return { agent, continuation, turns: [...turns.values()] };
}

export function readSessionSync(sessionsRoot, id) {
  const file = sessionTranscriptPath(sessionsRoot, id);
  const records = readTranscriptRecordsSync(file);
  if (records[0]?.type !== 'session' || records[0].id !== id) throw new Error(`Invalid ALA session transcript: ${file}`);
  const { mtime } = fs.statSync(file);
  const folded = foldTranscript(records);
  return { id, createdAt: records[0].at, updatedAt: mtime.toISOString(),
    title: folded.turns.find((turn) => turn.user)?.user || '', ...folded };
}

export function readTurnSync(sessionsRoot, id, turnId) {
  return readSessionSync(sessionsRoot, id).turns.find((turn) => turn.turnId === turnId) || null;
}

// Cheap listing data: the header and first user record from the beginning of
// the file plus its modification time. Returns null when the session has no
// transcript yet.
export function readSessionSummarySync(sessionsRoot, id) {
  const file = sessionTranscriptPath(sessionsRoot, id);
  let descriptor;
  try { descriptor = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const { mtime } = fs.fstatSync(descriptor);
    const buffer = Buffer.alloc(SUMMARY_BYTES);
    const bytesRead = fs.readSync(descriptor, buffer, 0, SUMMARY_BYTES, 0);
    const records = parseRecords(buffer.subarray(0, bytesRead).toString('utf8'), file);
    if (records[0]?.type !== 'session' || records[0].id !== id) return null;
    return { id, createdAt: records[0].at, updatedAt: mtime.toISOString(),
      title: records.find((record) => record.type === 'user')?.text || '' };
  } finally { fs.closeSync(descriptor); }
}

export function listSessionsSync(sessionsRoot) {
  let entries;
  try { entries = fs.readdirSync(path.join(sessionsRoot, 'sessions')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -6))
    .filter((id) => SESSION_ID.test(id)).map((id) => readSessionSummarySync(sessionsRoot, id)).filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readSession(sessionsRoot, id) { return readSessionSync(sessionsRoot, id); }
export async function readTurn(sessionsRoot, id, turnId) { return readTurnSync(sessionsRoot, id, turnId); }
export async function readSessionSummary(sessionsRoot, id) { return readSessionSummarySync(sessionsRoot, id); }
export async function listSessions(sessionsRoot) { return listSessionsSync(sessionsRoot); }
