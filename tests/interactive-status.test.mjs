import test from 'node:test';
import assert from 'node:assert/strict';

import { createThinkingIndicator } from '../src/interactive-status.mjs';
import { captureStream } from './helpers.mjs';

test('animates three thinking frames and clears the terminal line', async () => {
  const stream = captureStream();
  stream.isTTY = true;
  let tick = null;
  let cancelled = null;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const indicator = createThinkingIndicator(stream, {
    schedule(callback) { tick = callback; return timer; },
    cancel(value) { cancelled = value; }
  });

  const resultPromise = indicator.run(async () => {
    tick();
    tick();
    return 'done';
  });
  assert.equal(await resultPromise, 'done');
  assert.equal(timer.unrefCalled, true);
  assert.equal(cancelled, timer);
  assert.equal(
    stream.read(),
    '\r\u001b[2KThinking.\r\u001b[2KThinking..\r\u001b[2KThinking...\r\u001b[2K'
  );
});

test('does not render outside an interactive terminal and clears after failure', async () => {
  const nonTerminal = captureStream();
  const quiet = createThinkingIndicator(nonTerminal);
  assert.equal(await quiet.run(async () => 'done'), 'done');
  assert.equal(nonTerminal.read(), '');

  const terminal = captureStream();
  terminal.isTTY = true;
  const indicator = createThinkingIndicator(terminal, {
    schedule() { return 1; },
    cancel() {}
  });
  await assert.rejects(() => indicator.run(async () => { throw new Error('failed'); }), /failed/u);
  assert.equal(terminal.read(), '\r\u001b[2KThinking.\r\u001b[2K');
});
