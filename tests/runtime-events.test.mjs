import test from 'node:test';
import assert from 'node:assert/strict';

import { ALA_EVENT_PREFIX, createRuntimeEventSink } from '../src/runtime-events.mjs';
import { captureStream } from './helpers.mjs';

test('streams runtime events only when explicitly enabled', () => {
  const disabledStream = captureStream();
  createRuntimeEventSink({ stream: disabledStream, env: {} })({
    type: 'coding-agent-message', agent: 'codex', message: 'hidden\n'
  });
  assert.equal(disabledStream.read(), '');

  const enabledStream = captureStream();
  createRuntimeEventSink({ stream: enabledStream, env: { ALA_EVENT_STREAM: '1' } })({
    type: 'coding-agent-message', agent: 'codex', message: 'working\n'
  });
  assert.match(enabledStream.read(), new RegExp(`^${ALA_EVENT_PREFIX}`));
  assert.match(enabledStream.read(), /"agent":"codex"/u);
});
