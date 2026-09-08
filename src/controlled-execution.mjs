import { StringDecoder } from 'node:string_decoder';

import { ALAError, EXIT_CODES } from './errors.mjs';

export async function runControlledExecution(runtime, prompt, { input, eventSink, signal, instruction }) {
  const decoder = new StringDecoder('utf8');
  const controller = new AbortController();
  const executionSignal = controller.signal;
  let buffer = '';
  let discarding = false;
  let accepting = true;
  let pending = Promise.resolve();
  const queue = [];
  const requests = runtime.permissionRequests;
  const stop = (reason) => {
    if (executionSignal.aborted) return;
    accepting = false;
    controller.abort(new ALAError(`Execution interrupted: ${reason}`, EXIT_CODES.interrupted));
    requests?.setReplyCapability(false);
    runtime.cancel?.(reason);
  };
  const interrupted = () => stop('cancelled');
  const ended = () => {
    if (buffer.trim()) eventSink({ type: 'message-rejected', error: 'Incomplete control record at EOF.' });
    stop('control channel closed');
  };
  const failed = (error) => stop(`control channel failed: ${error.message}`);
  const deliver = (message) => new Promise((resolve, reject) => {
    const aborted = () => reject(executionSignal.reason);
    executionSignal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => {
      executionSignal.throwIfAborted();
      return runtime.sendMessage(message);
    }).then(resolve, reject).finally(() => executionSignal.removeEventListener('abort', aborted));
  });
  const dispatch = (line) => {
    let command;
    try {
      if (line.length > 65536) throw new Error('Input record too large.');
      command = JSON.parse(line);
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Invalid control command.');
      if (!accepting || executionSignal.aborted) throw new Error('Execution is no longer accepting messages.');
      if (command.type === 'interaction-response') {
        if (!requests) throw new Error('Interactive approval requires a control-capable runtime.');
        requests.resolve(command);
        return;
      }
      if (command.type !== 'message' || typeof command.message !== 'string'
          || !command.message.trim() || command.message.length > 32768) throw new Error('Invalid message command.');
    } catch (error) {
      eventSink({ type: command?.type === 'interaction-response' ? 'interaction-response-rejected' : 'message-rejected',
        id: command?.id, error: error.message });
      return;
    }
    pending = pending.then(async () => {
      try {
        if (!accepting || executionSignal.aborted) throw new Error('Execution is no longer accepting messages.');
        if (queue.length >= 100) throw new Error('Task message queue is full.');
        const result = await deliver(command.message);
        if (executionSignal.aborted) throw executionSignal.reason;
        if (result.delivery === 'queued') queue.push(command.message);
        eventSink({ type: 'message-accepted', id: command.id, ...result });
      } catch (error) { eventSink({ type: 'message-rejected', id: command.id, error: error.message }); }
    });
  };
  const receive = (chunk) => {
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (discarding) discarding = false;
      else dispatch(line);
    }
    if (buffer.length > 65536) {
      buffer = '';
      if (!discarding) eventSink({ type: 'message-rejected', error: 'Input record too large.' });
      discarding = true;
    }
  };
  requests?.setReplyCapability(true);
  signal?.addEventListener('abort', interrupted, { once: true });
  input.on('data', receive);
  input.once('end', ended);
  input.once('close', ended);
  input.once('error', failed);
  if (signal?.aborted) interrupted();
  if (input.readableEnded || input.destroyed) ended();
  try {
    executionSignal.throwIfAborted();
    let result = await runtime.execute(prompt, { signal: executionSignal, instruction });
    while (true) {
      await pending;
      executionSignal.throwIfAborted();
      if (!queue.length) break;
      result = await runtime.execute(queue.shift(), { signal: executionSignal });
    }
    return result;
  } finally {
    accepting = false;
    requests?.setReplyCapability(false);
    signal?.removeEventListener('abort', interrupted);
    input.off('data', receive);
    input.off('end', ended);
    input.off('close', ended);
    input.off('error', failed);
    input.pause?.();
    // A failed turn must also release steering receipts still awaiting a native reply.
    if (!executionSignal.aborted) controller.abort(new ALAError('Execution ended.', EXIT_CODES.interrupted));
    await pending;
    if (queue.length) eventSink({ type: 'messages-cancelled', count: queue.length });
  }
}
