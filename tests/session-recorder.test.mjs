import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALA_EVENT_PREFIX,
  createRuntimeEventSink,
  createSessionRecorder
} from '../src/session-recorder.mjs';
import { captureStream } from './helpers.mjs';

test('creates a private JSONL transcript lazily beside the active config', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-session-recorder-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const recorder = createSessionRecorder({ configPath: join(root, 'custom.json'), mode: 'one-shot' });

  await assert.rejects(() => readdir(join(root, 'sessions')), { code: 'ENOENT' });
  await recorder.recordPrompt('Find a useful discussion');
  recorder.record({ type: 'agentlib-tool', tool: 'coding-agent', reason: 'The task needs web research.' });
  recorder.record({ type: 'final', message: 'Done' });
  await recorder.close('completed');

  const files = await readdir(join(root, 'sessions'));
  assert.equal(files.length, 1);
  assert.equal((await stat(join(root, 'sessions'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'sessions', files[0]))).mode & 0o777, 0o600);
  const events = (await readFile(join(root, 'sessions', files[0]), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), [
    'session-started', 'prompt', 'agentlib-tool', 'final', 'session-ended'
  ]);
  assert.deepEqual(
    { tool: events[2].tool, reason: events[2].reason },
    { tool: 'coding-agent', reason: 'The task needs web research.' }
  );
  assert.equal(events[1].turn, 1);
  assert.equal(events[2].turn, 1);
});

test('streams runtime events only when explicitly enabled', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-event-stream-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const recorder = createSessionRecorder({ configPath: join(root, 'config.json') });
  await recorder.recordPrompt('hello');
  const stream = captureStream();
  const sink = createRuntimeEventSink({ recorder, stream, env: { ALA_EVENT_STREAM: '1' } });
  sink({ type: 'coding-agent-message', agent: 'codex', message: 'working\n' });
  await recorder.close();
  assert.match(stream.read(), new RegExp(`^${ALA_EVENT_PREFIX}`));
  assert.match(stream.read(), /"agent":"codex"/u);
});
