import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexLive, runPiLive } from '../src/coding-agents/live-agents.mjs';

function processFixture(handle) {
  return (options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const emit = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) handle(JSON.parse(line), emit, options);
    });
    child.kill = () => { queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); }); };
    return child;
  };
}

test('Codex resumes a thread, steers its active turn and returns the final response', async () => {
  let saved;
  let delivered;
  const methods = [];
  const result = await runCodexLive({ workspace: '/workspace', prompt: 'Continue.',
    continuation: { threadId: 'saved-thread' }, onSession: async (value) => { saved = value; },
    setMessageHandler: (handler) => { if (handler) delivered = handler('check tests'); },
    spawnImpl: processFixture((request, emit) => {
      methods.push(request.method);
      if (request.method === 'initialized') return;
      let result = {};
      if (request.method === 'thread/resume') {
        assert.equal(request.params.threadId, 'saved-thread'); result = { thread: { id: 'saved-thread' } };
      }
      if (request.method === 'turn/start') {
        assert.equal(saved.threadId, 'saved-thread'); result = { turn: { id: 'turn-1' } };
      }
      emit({ id: request.id, result });
      if (request.method === 'turn/steer') {
        assert.equal(request.params.expectedTurnId, 'turn-1');
        emit({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } });
        emit({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { status: 'completed' } } });
      }
    }) });
  assert.deepEqual(await delivered, { delivery: 'delivered' });
  assert.equal(result.outputText, 'done');
  assert.ok(!methods.includes('thread/start'));
});

test('Codex Stop interrupts the native turn after saving its resumable identity', async () => {
  const controller = new AbortController();
  let saved;
  let interrupted = false;
  await assert.rejects(runCodexLive({ workspace: '/workspace', prompt: 'work', signal: controller.signal,
    onSession: async (value) => { saved = value; },
    setMessageHandler: (handler) => { if (handler) controller.abort(); },
    spawnImpl: processFixture((request, emit) => {
      if (request.method === 'initialized') return;
      let result = {};
      if (request.method === 'thread/start') result = { thread: { id: 'durable-thread' } };
      if (request.method === 'turn/start') result = { turn: { id: 'active-turn' } };
      emit({ id: request.id, result });
      if (request.method === 'turn/interrupt') {
        assert.equal(saved.threadId, 'durable-thread');
        assert.equal(request.params.turnId, 'active-turn');
        interrupted = true;
        emit({ method: 'turn/completed', params: { threadId: 'durable-thread', turn: { status: 'interrupted' } } });
      }
    }) }), /interrupted/);
  assert.equal(interrupted, true);
});

test('Pi records its session before prompting and waits for settled after low-level completion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-pi-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let saved;
  let delivered;
  const result = await runPiLive({ workspace: '/workspace', hostWorkspace: root, prompt: 'work',
    onSession: async (value) => { saved = value; },
    setMessageHandler: (handler) => { if (handler) delivered = handler('new instruction'); },
    spawnImpl: processFixture((request, emit) => {
      const data = request.type === 'get_state'
        ? { sessionId: 'pi-id', sessionFile: '/workspace/.ala-pi-sessions/pi.jsonl' } : {};
      if (request.type === 'prompt') assert.equal(saved.sessionId, 'pi-id');
      emit({ id: request.id, type: 'response', success: true, data });
      if (request.type === 'steer') {
        emit({ type: 'agent_end' });
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } });
        emit({ type: 'agent_settled' });
      }
    }) });
  assert.deepEqual(await delivered, { delivery: 'delivered' });
  assert.equal(result.outputText, 'final');
  assert.equal(result.continuation.sessionId, 'pi-id');
});
