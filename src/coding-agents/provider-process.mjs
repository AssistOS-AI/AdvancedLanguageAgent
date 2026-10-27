import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { providerError } from './provider.mjs';

const STOP_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL']);

// A child-process stand-in for one process that a protocol provider runs elsewhere. It offers the surface the
// coding-agent adapters use (stdin, stdout, stderr, kill, exitCode, 'error', 'exit', 'close') so that adapters do
// not know which provider started the process. The provider delivers each standard stream as a connected socket;
// until it arrives, input written by the adapter waits in the pass-through and nothing is lost.
export function createProviderProcess({ id, stdin, graceMs, requestStop }) {
  const child = new EventEmitter();
  const sinks = { stdout: new PassThrough(), stderr: new PassThrough() };
  const stdinStream = stdin === 'ignore' ? null : new PassThrough();
  const attached = new Set();
  const ended = new Set();
  let exited = false;
  let closed = false;
  let failure = null;

  Object.assign(child, {
    providerId: id, pid: undefined, exitCode: null, signalCode: null, killed: false,
    stdin: stdinStream, stdout: sinks.stdout, stderr: sinks.stderr
  });

  const finish = () => {
    if (closed || !exited || ended.size < 2) return;
    closed = true;
    child.emit('close', child.exitCode, child.signalCode);
  };
  for (const [name, sink] of Object.entries(sinks)) {
    sink.once('end', () => { ended.add(name); finish(); });
    sink.once('error', () => { ended.add(name); finish(); });
  }

  child.kill = (signal = 'SIGTERM') => {
    if (!STOP_SIGNALS.has(signal)) {
      throw providerError(`Unsupported signal for an execution-provider process: ${signal}`);
    }
    if (exited) return false;
    child.killed = true;
    requestStop(signal === 'SIGKILL' ? 0 : graceMs);
    return true;
  };

  const control = {
    attachStream(name, socket) {
      if (exited || attached.has(name) || (name === 'stdin' && !stdinStream)
          || (name !== 'stdin' && !sinks[name])) {
        socket.destroy?.();
        return false;
      }
      attached.add(name);
      if (name === 'stdin') {
        socket.on('error', (error) => stdinStream.destroy(error));
        stdinStream.pipe(socket);
      } else {
        socket.on('error', () => sinks[name].end());
        socket.on('close', () => sinks[name].end());
        socket.pipe(sinks[name]);
      }
      return true;
    },
    exit(code, signal) {
      if (exited) return;
      exited = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
      // A stream the provider never delivered cannot end by itself.
      for (const [name, sink] of Object.entries(sinks)) if (!attached.has(name)) sink.end();
      finish();
    },
    fail(error) {
      if (failure || closed) return;
      failure = error;
      // Listeners attach after the synchronous start, so an error is never raised on the caller's own stack.
      process.nextTick(() => {
        if (child.listenerCount('error') > 0) child.emit('error', error);
        stdinStream?.destroy();
        for (const sink of Object.values(sinks)) sink.end();
        control.exit(null, null);
      });
    },
    get finished() { return closed; }
  };
  return { child, control };
}
