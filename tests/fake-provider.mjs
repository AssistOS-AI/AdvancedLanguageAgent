import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';

import { AGENT_NAMES } from '../src/coding-agents/discovery.mjs';
import { PROVIDER_PROTOCOL } from '../src/coding-agents/provider.mjs';

// A deterministic in-memory execution provider (the server side of wire protocol version 1) for the conformance
// tests. It starts no process: a behavior function scripts what each request produces. The channel pair stands in
// for the Node IPC channel, with the same message serialization (a JSON round trip), ordered asynchronous delivery,
// the send callback, and asynchronous write errors, and it passes stream objects where IPC passes socket handles.

export function duplexPair() {
  const make = () => {
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) { stream.peer.push(chunk); callback(); },
      final(callback) { stream.peer.push(null); callback(); }
    });
    // The socket methods node:http calls on a pooled connection; a handle received over IPC is a net.Socket.
    Object.assign(stream, { setKeepAlive() { return stream; }, setNoDelay() { return stream; },
      setTimeout() { return stream; }, ref() { return stream; }, unref() { return stream; } });
    return stream;
  };
  const left = make();
  const right = make();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

// `breakWrites()` on a side makes its later sends fail the way a dead IPC peer does: no exception from send(), an
// asynchronous error through the callback, and an 'error' event on the channel.
export function createChannelPair() {
  const make = () => Object.assign(new EventEmitter(), { connected: true, sent: [], writesBroken: false });
  const client = make();
  const server = make();
  const link = (from, to) => {
    from.send = (message, handle, callback) => {
      if (typeof handle === 'function') { callback = handle; handle = undefined; }
      if (!from.connected) throw Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
      if (from.writesBroken) {
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        setImmediate(() => { callback?.(error); from.emit('error', error); });
        return false;
      }
      from.sent.push(message);
      const copy = JSON.parse(JSON.stringify(message));
      setImmediate(() => { if (to.connected) to.emit('message', copy, handle); callback?.(null); });
      return true;
    };
    from.breakWrites = () => { from.writesBroken = true; };
    from.disconnect = () => {
      if (!from.connected) return;
      from.connected = false;
      to.connected = false;
      setImmediate(() => { from.emit('disconnect'); to.emit('disconnect'); });
    };
  };
  link(client, server);
  link(server, client);
  return { client, server };
}

const DEFAULT_INVENTORY = [{ name: 'codex', version: '0.1.0' }, { name: 'claude', version: '2.1.0' }];
const RESERVED = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR']);
const within = (child, parent) => child === parent || child.startsWith(`${parent}/`);
const KNOWN_CLIENT_MESSAGES = new Set(['hello', 'inventory', 'tempdir', 'start', 'stop', 'connect']);

// The fake's own admission policy, the obligations of section 5.3 stated generically: a known process class, a
// backend name from the inventory (never a path), HOME exactly /home/robot, a working directory inside the admitted
// view, folders that are a subset of the admitted grants at equal or lower access, no provider-owned variable, only
// added exclusions, and a network mode that is never wider.
function admit(request, { grants, inventory }) {
  if (!request || typeof request !== 'object') return 'malformed request';
  if (!['run', 'session', 'service'].includes(request.processClass)) return 'unknown process class';
  if (!AGENT_NAMES.includes(request.executable) || !inventory.some((entry) => entry.name === request.executable)) {
    return 'executable is not in the tool inventory';
  }
  if (request.home !== '/home/robot') return 'HOME must be /home/robot';
  const view = [...grants.map((grant) => grant.path), '/home/robot', '/tmp'];
  const inView = (path) => typeof path === 'string' && path.startsWith('/') && !path.split('/').includes('..')
    && view.some((root) => within(path, root));
  if (!inView(request.cwd)) return 'working directory is outside the admitted view';
  for (const folder of request.folders || []) {
    const grant = grants.find((candidate) => within(folder.path, candidate.path));
    if (!grant) return 'folder is outside the admitted grants';
    if (!['read', 'write'].includes(folder.access)) return 'unknown folder access';
    if (folder.access === 'write' && grant.access !== 'write') return 'folder access is wider than the grant';
  }
  for (const name of Object.keys(request.env || {})) {
    if (RESERVED.has(name) || name.startsWith('XDG_')) return `environment variable ${name} is provider-owned`;
  }
  if (!Array.isArray(request.exclusions) || request.exclusions.some((path) => !inView(path))) {
    return 'exclusion cannot be enforced';
  }
  if (!['robot-egress', 'none'].includes(request.network)) return 'network mode is unknown';
  if (request.requirements?.privateProc !== true) return 'private /proc is required';
  return null;
}

// options: pair (async factory of connected stream pairs, default in-memory), version, protocol, answerHello (false =
// silent), silentAfterHello (answers the handshake only), inventory, tempdir, grants, refuse(request) -> message,
// crashOnStart, failOnStart (per-process failure instead of started), failAfterStarted (per-process failure after
// started), ignoreConnect (never answers a connect request), failAll (channel-wide failure on the first request of any kind), behavior({ request, stdin, stdout,
// stderr, exit, process }), onConnect(stream, endpoint), onStop.
export function createFakeProvider(channel, options = {}) {
  const messages = [];
  const starts = [];
  const stops = [];
  const live = new Map();
  const grants = options.grants || [{ path: '/projects', access: 'write' }];
  const inventory = options.inventory ?? DEFAULT_INVENTORY;
  const send = (message, handle) => { if (channel.connected) channel.send(message, handle); };

  async function startProcess(message) {
    const request = message.request;
    starts.push({ process: message.process, request });
    if (options.crashOnStart) { channel.disconnect(); return; }
    const refusal = options.refuse?.(request)
      || admit(request, { grants, inventory: Array.isArray(inventory) ? inventory : [] });
    if (refusal) {
      send({ type: 'refused', process: message.process, error: { code: 'refused', message: refusal } });
      return;
    }
    if (options.failOnStart) {
      send({ type: 'failure', process: message.process, error: { code: 'setup', message: 'sandbox setup failed' } });
      return;
    }
    send({ type: 'started', process: message.process });
    if (options.failAfterStarted) {
      send({ type: 'failure', process: message.process, error: { code: 'lost', message: 'workload domain was lost' } });
      return;
    }
    const sides = {};
    for (const name of ['stdin', 'stdout', 'stderr']) {
      if (name === 'stdin' && request.communication.stdin === 'ignore') continue;
      const [local, remote] = await (options.pair || duplexPair)();
      sides[name] = local;
      send({ type: 'stream', process: message.process, stream: name }, remote);
    }
    const exit = (code = 0, signal = null) => {
      sides.stdout.end();
      sides.stderr.end();
      setImmediate(() => send({ type: 'exit', process: message.process, code, signal }));
      live.delete(message.process);
    };
    live.set(message.process, { exit });
    options.behavior?.({ request, process: message.process, stdin: sides.stdin, stdout: sides.stdout,
      stderr: sides.stderr, exit });
  }

  // A provider rejects a client message that carries a handle or has an unknown type: the client never sends either.
  const rejectChannel = (text) => send({ type: 'failure', error: { code: 'protocol', message: text } });

  async function handleMessage(message, handle) {
    if (handle) { handle.destroy?.(); rejectChannel('client messages carry no handles'); return; }
    if (!message || !KNOWN_CLIENT_MESSAGES.has(message.type)) { rejectChannel('unknown message type'); return; }
    if (message.type === 'hello') {
      if (options.answerHello === false) return;
      send({ type: 'hello', protocol: options.protocol || PROVIDER_PROTOCOL, version: options.version ?? 1 });
      return;
    }
    if (options.silentAfterHello) return;
    if (options.failAll) {
      send({ type: 'failure', error: { code: 'setup', message: 'worker is shutting down' } });
      return;
    }
    switch (message.type) {
      case 'inventory':
        send({ type: 'result', id: message.id, ok: true, value: options.inventory ?? DEFAULT_INVENTORY });
        return;
      case 'tempdir':
        send({ type: 'result', id: message.id, ok: true, value: { path: options.tempdir ?? '/tmp/ala-execution-1' } });
        return;
      case 'start':
        await startProcess(message);
        return;
      case 'stop':
        stops.push({ process: message.process, graceMs: message.graceMs });
        if (options.onStop) options.onStop(message, live.get(message.process));
        else live.get(message.process)?.exit(null, message.graceMs === 0 ? 'SIGKILL' : 'SIGTERM');
        return;
      case 'connect': {
        if (options.ignoreConnect) return;
        if (!options.onConnect) {
          send({ type: 'result', id: message.id, ok: false, error: { code: 'refused', message: 'no service' } });
          return;
        }
        const [local, remote] = await (options.pair || duplexPair)();
        options.onConnect(local, message.endpoint);
        send({ type: 'result', id: message.id, ok: true, value: {} }, remote);
        return;
      }
      default:
    }
  }

  // Messages are handled in arrival order even when a handler awaits a socket pair.
  let queue = Promise.resolve();
  channel.on('message', (message, handle) => {
    messages.push(message);
    queue = queue.then(() => handleMessage(message, handle)).catch(() => {});
  });
  return { messages, starts, stops, live };
}
