import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { openSessionState } from '../src/session-state.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { runControlledExecution } from '../src/controlled-execution.mjs';
import { createPermissionRequestManager } from '../src/permission-requests.mjs';

test('reopens native continuation across runtimes and refuses backend or cwd replacement', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-session-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = { id: randomUUID(), home: root, workspace: root };
  const state = await openSessionState(context);
  await assert.rejects(openSessionState(context), /already running/);
  const agents = [{ name: 'codex', available: true, binary: '/fake/codex' },
    { name: 'pi', available: true, binary: '/fake/pi' }];
  const first = createCodingAgentService({ agents, workspace: root, home: root, sessionState: state,
    runners: { codex: async ({ onSession }) => {
      await onSession({ threadId: 'thread-saved-before-stop' });
      throw new Error('interrupted');
    } } });
  await assert.rejects(first.execute('original'), /interrupted/);
  await first.close(); await state.close();
  await assert.rejects(openSessionState({ ...context, workspace: '/other', resume: true }), /cannot be resumed/);
  const reopened = await openSessionState({ ...context, resume: true });
  const second = createCodingAgentService({ agents, workspace: root, home: root, sessionState: reopened,
    runners: { codex: async ({ prompt, continuation }) => {
      assert.equal(prompt, 'Continue.');
      assert.equal(continuation.threadId, 'thread-saved-before-stop');
      return { outputText: 'done', continuation };
    } } });
  await assert.rejects(second.execute('switch', { agent: 'pi' }), /pinned to codex/);
  assert.equal(await second.execute('Continue.'), 'done');
  await second.close(); await reopened.close();
  await assert.rejects(openSessionState({ ...context, id: randomUUID(), resume: true }), /ENOENT/);
  const record = JSON.parse(await fs.readFile(path.join(root, '.ala/sessions', `${context.id}.json`), 'utf8'));
  assert.equal('prompt' in record, false);
});

test('concurrent stale-lock recovery admits only one session writer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-lock-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = { id: randomUUID(), home: root, workspace: root };
  const initial = await openSessionState(context);
  await initial.save({ agent: 'codex', continuation: { threadId: 'saved' } });
  await initial.close();
  const lock = path.join(root, '.ala/sessions', `${context.id}.json.lock`);
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483647, start: 'dead-process' }));
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => openSessionState({ ...context, resume: true })));
  const accepted = attempts.filter((result) => result.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  await accepted[0].value.close();
});

test('Stop discards pending follow-ups without executing a second turn', async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const events = [];
  let turns = 0;
  const execution = runControlledExecution({
    execute: async () => {
      turns += 1;
      await new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('stopped'))));
    },
    sendMessage: async () => ({ delivery: 'queued' }),
  }, 'original', { input, signal: controller.signal, eventSink: (event) => events.push(event) });
  input.write('{"type":"message","id":"one","message":"follow-up"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(execution, /stopped/);
  assert.equal(turns, 1);
  assert.ok(events.some((event) => event.type === 'messages-cancelled' && event.count === 1));
});

test('live delivery and queued follow-up use the same runtime without concurrent execution', async () => {
  const input = new PassThrough();
  const events = [];
  const prompts = [];
  let finish;
  const runtime = {
    execute: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) await new Promise((resolve) => { finish = resolve; });
      return `result-${prompts.length}`;
    },
    sendMessage: async (message) => ({ delivery: message === 'steer' ? 'delivered' : 'queued' })
  };
  const execution = runControlledExecution(runtime, 'original', { input, eventSink: (event) => events.push(event) });
  input.write(`${JSON.stringify({ type: 'message', id: 'one', message: 'steer' })}\n`);
  input.write(`${JSON.stringify({ type: 'message', id: 'two', message: 'follow-up' })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.delivery), ['delivered', 'queued']);
  assert.deepEqual(prompts, ['original']);
  finish();
  assert.equal(await execution, 'result-2');
  assert.deepEqual(prompts, ['original', 'follow-up']);
});

test('interaction responses bypass a steering receipt awaiting the same native approval', { timeout: 2000 }, async () => {
  const input = new PassThrough();
  const events = [];
  const eventSink = (event) => events.push(event);
  const permissionRequests = createPermissionRequestManager({ eventSink, logger: { warn() {} } });
  const prompts = [];
  let answer;
  const runtime = {
    permissionRequests,
    execute: async (prompt) => {
      prompts.push(prompt);
      answer = permissionRequests.request({
        agent: 'codex', method: 'item/commandExecution/requestApproval', title: 'Run', message: 'Write scratch',
        options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }]
      });
      return await answer === 'allow' ? 'allowed' : 'denied';
    },
    sendMessage: async () => {
      await answer;
      return { delivery: 'delivered' };
    }
  };
  const execution = runControlledExecution(runtime, 'original', { input, eventSink });
  input.write('{"type":"message","id":"steering","message":"Please check carefully"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  input.write(`${JSON.stringify({ type: 'interaction-response', id: answer.id, optionId: 'invalid' })}\n`);
  input.write(`${JSON.stringify({ type: 'interaction-response', id: answer.id, optionId: 'deny' })}\n`);
  assert.equal(await execution, 'denied');
  assert.deepEqual(prompts, ['original']);
  assert.ok(events.some((event) => event.type === 'interaction-response-rejected' && event.id === answer.id));
  assert.ok(events.some((event) => event.type === 'message-accepted' && event.id === 'steering'
    && event.delivery === 'delivered'));
});

test('control EOF cancels native approvals and the owned execution, not a successful empty answer', {
  timeout: 2000
}, async () => {
  const input = new PassThrough();
  const events = [];
  const permissionRequests = createPermissionRequestManager({ eventSink: (event) => events.push(event) });
  let answer;
  let cancelled = 0;
  const runtime = {
    permissionRequests,
    execute: async (_prompt, { signal }) => {
      answer = permissionRequests.request({
        agent: 'codex', method: 'item/commandExecution/requestApproval', title: 'Run', message: 'Write scratch',
        options: [{ id: 'allow', label: 'Allow' }]
      }, { signal, onCancel: () => { cancelled += 1; } });
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    cancel() { cancelled += 1; }
  };
  const execution = runControlledExecution(runtime, 'original', {
    input, eventSink: (event) => events.push(event)
  });
  input.end();
  await assert.rejects(execution, { exitCode: 130 });
  assert.equal(await answer, null);
  assert.equal(cancelled, 2);
  assert.equal(permissionRequests.replyCapable, false);
  assert.deepEqual(events.at(-1), { type: 'coding-agent-request-resolved', id: answer.id, reason: 'cancelled' });
});
