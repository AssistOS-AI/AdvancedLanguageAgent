import { StringDecoder } from 'node:string_decoder';

export async function runControlledExecution(runtime, prompt, { input, eventSink, signal, instruction }) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let accepting = true;
  let pending = Promise.resolve();
  const queue = [];
  const receive = (chunk) => {
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      pending = pending.then(async () => {
        let command;
        try {
          if (line.length > 65536) throw new Error('Input record too large.');
          command = JSON.parse(line);
          if (!accepting || signal?.aborted) throw new Error('Execution is no longer accepting messages.');
          if (command.type !== 'message' || typeof command.message !== 'string'
              || !command.message.trim() || command.message.length > 32768) throw new Error('Invalid message command.');
          if (queue.length >= 100) throw new Error('Task message queue is full.');
          const result = await runtime.sendMessage(command.message);
          if (result.delivery === 'queued') queue.push(command.message);
          eventSink({ type: 'message-accepted', id: command.id, ...result });
        } catch (error) { eventSink({ type: 'message-rejected', id: command?.id, error: error.message }); }
      });
    }
    if (buffer.length > 65536) { buffer = ''; eventSink({ type: 'message-rejected', error: 'Input record too large.' }); }
  };
  input.on('data', receive);
  try {
    let result = await runtime.execute(prompt, { signal, instruction });
    while (true) {
      await pending;
      if (!queue.length || signal?.aborted) break;
      result = await runtime.execute(queue.shift(), { signal });
    }
    return result;
  } finally {
    accepting = false;
    input.off('data', receive);
    input.pause?.();
    await pending;
    if (queue.length) eventSink({ type: 'messages-cancelled', count: queue.length });
  }
}
