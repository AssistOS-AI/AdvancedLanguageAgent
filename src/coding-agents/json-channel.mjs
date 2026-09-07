import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { requireSandbox, spawnProcess } from './process.mjs';

export function openJsonChannel(input, args, spawnImpl = input.spawnImpl || spawnProcess) {
  if (spawnImpl === spawnProcess) requireSandbox(input.sandbox);
  const events = new EventEmitter();
  const child = spawnImpl({ ...input, args, cwd: input.workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let counter = 0;
  let failure = null;
  let exited = false;
  const fail = (error) => {
    failure ||= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    events.emit('failure', error);
  };
  child.on('error', fail);
  child.on('close', () => { exited = true; fail(new Error('Coding-agent control process closed.')); });
  child.stdin.on('error', fail);
  child.stderr.on('data', (chunk) => input.onVisibleText?.(chunk.toString('utf8')));
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 8 * 1024 * 1024) return fail(new Error('Coding-agent protocol record too large.'));
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { fail(new Error('Invalid coding-agent JSON record.')); continue; }
      const entry = pending.get(String(event.id));
      if (entry) {
        pending.delete(String(event.id)); clearTimeout(entry.timer);
        if (event.error || event.success === false) entry.reject(new Error(event.error?.message || event.error || 'Agent rejected command.'));
        else entry.resolve(event.result ?? event.data ?? event);
      } else if (event.id !== undefined && event.method) {
        child.stdin.write(`${JSON.stringify({ id: event.id, error: { code: -32601, message: 'Interactive request unsupported' } })}\n`);
      } else events.emit('event', event);
    }
  });
  const send = (value) => {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    events, send,
    request(value) {
      if (failure) return Promise.reject(failure);
      const id = String(++counter);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent command timed out.')); }, 30000);
        pending.set(id, { resolve, reject, timer });
        send({ ...value, id });
      });
    },
    wait(predicate) {
      if (failure) return Promise.reject(failure);
      const result = new Promise((resolve, reject) => {
        const cleanup = () => { events.off('event', receive); events.off('failure', failed); };
        const receive = (event) => { if (predicate(event)) { cleanup(); resolve(event); } };
        const failed = (error) => { cleanup(); reject(error); };
        events.on('event', receive); events.on('failure', failed);
      });
      result.catch(() => {});
      return result;
    },
    async close() {
      if (exited || (child.exitCode !== null && child.exitCode !== undefined)) return;
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      await closed; clearTimeout(timer);
    }
  };
}
