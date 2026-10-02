import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { openSessionState, resolveSessionsRoot } from '../src/session-state.mjs';
import { createTranscriptRecorder } from '../src/transcript-recorder.mjs';
import { listSessions, readSession, readSessionSummary, readTurn } from '../src/transcript.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-transcript-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('ALA_SESSIONS selects the sessions directory, otherwise <cwd>/.ala', () => {
  assert.equal(resolveSessionsRoot({ env: {}, cwd: '/work' }), '/work/.ala');
  assert.equal(resolveSessionsRoot({ env: { ALA_SESSIONS: '/work/.roboteam/.ala' }, cwd: '/work' }), '/work/.roboteam/.ala');
  assert.equal(resolveSessionsRoot({ env: { ALA_SESSIONS: 'state' }, cwd: '/work' }), '/work/state');
});

test('a recorded turn folds into the user message, intermediate output, final answer and status', async (t) => {
  const root = await tempRoot(t);
  const id = randomUUID();
  const state = await openSessionState({ id, sessionsRoot: root });
  const turn = createTranscriptRecorder(state, 'turn-1');
  await turn.user('Fix the bug');
  turn.observe({ type: 'coding-agent-message', message: 'Looking ', outputKind: 'assistant', outputId: 'a1' });
  turn.observe({ type: 'coding-agent-message', message: 'at it.', outputKind: 'assistant', outputId: 'a1', outputComplete: true });
  turn.observe({ type: 'coding-agent-message', message: '$ npm test\n', outputKind: 'output' });
  turn.observe({ type: 'agentlib-tool', tool: 'coding-agent', reason: 'edit' });
  await turn.user('Also add a test');
  await turn.finish({ result: 'Done.', status: 'completed' });
  await state.save({ agent: 'codex', continuation: { threadId: 't1' } });
  await state.close();

  const session = await readSession(root, id);
  assert.equal(session.title, 'Fix the bug');
  assert.equal(session.agent, 'codex');
  assert.deepEqual(session.continuation, { threadId: 't1' });
  const [folded] = session.turns;
  assert.equal(folded.turnId, 'turn-1');
  assert.equal(folded.user, 'Fix the bug');
  assert.deepEqual(folded.followUps.map((entry) => entry.text), ['Also add a test']);
  assert.deepEqual(folded.messages.map((entry) => [entry.outputKind, entry.text]),
    [['assistant', 'Looking at it.'], ['output', '$ npm test\n']]);
  assert.deepEqual(folded.tools.map((entry) => entry.tool), ['coding-agent']);
  assert.equal(folded.final, 'Done.');
  assert.equal(folded.status, 'completed');
  assert.ok(Number.isInteger(folded.durationMs));
  assert.deepEqual(await readTurn(root, id, 'turn-1'), folded);
  assert.equal(await readTurn(root, id, 'missing'), null);
});

test('resumed turns append to the same transcript without rewriting earlier lines', async (t) => {
  const root = await tempRoot(t);
  const id = randomUUID();
  const first = await openSessionState({ id, sessionsRoot: root });
  await first.save({ agent: 'opencode', continuation: { sessionId: 'ses1' } });
  const one = createTranscriptRecorder(first, 'turn-1');
  await one.user('first');
  await one.finish({ result: 'one', status: 'completed' });
  await first.close();
  const file = path.join(root, 'sessions', `${id}.jsonl`);
  const before = await fs.readFile(file, 'utf8');

  const second = await openSessionState({ id, sessionsRoot: root, resume: true });
  const two = createTranscriptRecorder(second, 'turn-2');
  await two.user('second');
  await two.finish({ status: 'interrupted', error: 'Execution interrupted.' });
  await second.close();
  const after = await fs.readFile(file, 'utf8');
  assert.ok(after.startsWith(before));
  const session = await readSession(root, id);
  assert.deepEqual(session.turns.map((turn) => [turn.turnId, turn.status, turn.final]),
    [['turn-1', 'completed', 'one'], ['turn-2', 'interrupted', null]]);
  assert.equal(session.turns[1].error, 'Execution interrupted.');
});

test('an unfinished trailing append is ignored by readers', async (t) => {
  const root = await tempRoot(t);
  const id = randomUUID();
  const state = await openSessionState({ id, sessionsRoot: root });
  await createTranscriptRecorder(state, 'turn-1').user('hello');
  await state.close();
  await fs.appendFile(path.join(root, 'sessions', `${id}.jsonl`), '{"seq":3,"type":"fin');
  assert.equal((await readSession(root, id)).turns[0].user, 'hello');
});

test('session listing returns summaries newest first and skips foreign files', async (t) => {
  const root = await tempRoot(t);
  assert.deepEqual(await listSessions(root), []);
  const older = randomUUID();
  const newer = randomUUID();
  for (const [id, text] of [[older, 'older task'], [newer, 'newer task']]) {
    const state = await openSessionState({ id, sessionsRoot: root });
    await createTranscriptRecorder(state, 'turn').user(text);
    await state.close();
  }
  const past = new Date(Date.now() - 60000);
  await fs.utimes(path.join(root, 'sessions', `${older}.jsonl`), past, past);
  await fs.writeFile(path.join(root, 'sessions', 'notes.jsonl'), 'x\n');
  assert.deepEqual((await listSessions(root)).map((entry) => entry.title), ['newer task', 'older task']);
  assert.equal(await readSessionSummary(root, randomUUID()), null);
});

test('a transcript without native continuation is continued, one with continuation must be resumed', async (t) => {
  const root = await tempRoot(t);
  const id = randomUUID();
  const first = await openSessionState({ id, sessionsRoot: root });
  await createTranscriptRecorder(first, 'turn-1').finish({ status: 'failed', error: 'no agent' });
  await first.close();
  const second = await openSessionState({ id, sessionsRoot: root });
  await second.save({ agent: 'codex', continuation: { threadId: 't' } });
  await second.close();
  await assert.rejects(openSessionState({ id, sessionsRoot: root }), /use --resume-session/);
  const records = (await readSession(root, id)).turns;
  assert.deepEqual(records.map((turn) => turn.status), ['failed']);
});

test('the final record holds the same text ALA writes to stdout for a structured result', async (t) => {
  const root = await tempRoot(t);
  const id = randomUUID();
  const state = await openSessionState({ id, sessionsRoot: root });
  const turn = createTranscriptRecorder(state, 'turn-1');
  await turn.user('question');
  await turn.finish({ result: { result: 'Final answer' }, status: 'completed' });
  const other = createTranscriptRecorder(state, 'turn-2');
  await other.finish({ result: { result: { files: 2 } }, status: 'completed' });
  await state.close();
  const session = await readSession(root, id);
  assert.equal(session.turns[0].final, 'Final answer');
  assert.equal(session.turns[1].final, JSON.stringify({ files: 2 }, null, 2));
});
