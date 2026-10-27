import { AGENT_NAMES } from './discovery.mjs';
import { createProviderProcess } from './provider-process.mjs';
import { describeProcessRequest } from './provider-request.mjs';
import {
  DEFAULT_STOP_GRACE_MS, PROVIDER_PROTOCOL, PROVIDER_PROTOCOL_VERSION, providerError, providerText
} from './provider.mjs';
import { virtualPathProblem } from './virtual-paths.mjs';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_INVENTORY = 16;
const isStream = (value) => Boolean(value) && typeof value.pipe === 'function' && typeof value.on === 'function'
  && typeof value.destroy === 'function';

// The protocol client: it speaks wire protocol version 1 (DS006) to the worker's execution provider over one
// descriptor that the embedding service passes at launch. `channel` is that descriptor as a Node IPC channel
// (the process itself when it was started with one): it carries JSON control messages and, as passed handles, the
// connected sockets for standard streams and service connections. The client starts no process of its own and
// never falls back to another provider; every failure surfaces as an explicit execution error.
export function createProtocolProvider({
  channel = process, baseEnv = process.env, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  if (!channel || typeof channel.send !== 'function' || typeof channel.on !== 'function'
      || channel.connected === false) {
    throw providerError('The execution-provider descriptor is missing: '
      + 'no connected control channel was passed at launch.');
  }
  const processes = new Map();
  const requests = new Map();
  const abandoned = new Set();
  const abandonedProcesses = new Set();
  const outbox = [];
  let lastProcess = 0;
  let lastRequest = 0;
  let ready = false;
  let failure = null;
  let closed = false;
  let handshakeTimer = null;

  const fail = (error) => {
    if (failure) return;
    failure = error;
    clearTimeout(handshakeTimer);
    outbox.length = 0;
    for (const entry of requests.values()) { clearTimeout(entry.timer); entry.reject(error); }
    requests.clear();
    for (const { control, startTimer } of processes.values()) { clearTimeout(startTimer); control.fail(error); }
  };
  const violation = (detail) => fail(providerError(`Execution provider protocol violation: ${detail}.`));
  // Real IPC reports a write error asynchronously, through the send callback or an 'error' event on the channel, so
  // both end in an explicit execution error rather than an unhandled event.
  const sendFailed = (error) => fail(providerError('Execution provider connection is closed.', { cause: error }));
  const transmit = (message) => {
    try { channel.send(message, (error) => { if (error) sendFailed(error); }); } catch (error) { sendFailed(error); }
  };
  const send = (message) => {
    if (failure) return;
    if (ready) transmit(message); else outbox.push(message);
  };
  const discard = (handle) => { try { handle?.destroy?.(); } catch {} };
  const refusal = (error) => providerError(
    `Execution provider refused the request: ${providerText(error?.message || error?.code)}`);
  const failed = (error) => providerError(
    `Execution provider failed: ${providerText(error?.message || error?.code)}`);

  function onHello(message) {
    if (ready) return violation('repeated hello');
    if (message.protocol !== PROVIDER_PROTOCOL) return violation('unknown protocol');
    if (message.version !== PROVIDER_PROTOCOL_VERSION) {
      return fail(providerError(`Execution provider protocol version ${providerText(message.version)} is not supported; `
        + `ALA speaks version ${PROVIDER_PROTOCOL_VERSION}.`));
    }
    ready = true;
    clearTimeout(handshakeTimer);
    for (const queued of outbox.splice(0)) transmit(queued);
  }

  function onResult(message, handle) {
    const entry = requests.get(message.id);
    if (!entry) {
      discard(handle);
      if (abandoned.delete(message.id)) return undefined;
      return violation('result for an unknown request');
    }
    clearTimeout(entry.timer);
    requests.delete(message.id);
    if (message.ok !== true) { discard(handle); entry.reject(refusal(message.error)); return; }
    if (entry.expectHandle !== Boolean(handle)) {
      discard(handle);
      entry.reject(providerError('Execution provider answered without the expected connection.'));
      return;
    }
    entry.resolve({ value: message.value, handle });
  }

  function onProcessMessage(message, handle) {
    // The client gave up on this process when its start timed out and told the provider to stop it: whatever the
    // provider still sends for it is discarded, and only that operation has failed.
    if (abandonedProcesses.has(message.process)) {
      discard(handle);
      if (message.type === 'exit') abandonedProcesses.delete(message.process);
      return;
    }
    const entry = processes.get(message.process);
    if (!entry) {
      discard(handle);
      // A stream for a process that has already ended arrived after its `exit`: the provider must deliver every
      // requested stream before the exit.
      if (message.type === 'stream' || !Number.isInteger(message.process) || message.process < 1
          || message.process > lastProcess) {
        violation('message for an unknown or ended process');
      }
      return;
    }
    clearTimeout(entry.startTimer);
    if (message.type === 'started') {
      if (handle) { discard(handle); violation('a handle arrived with started'); }
      return;
    }
    if (message.type === 'refused') { discard(handle); entry.control.fail(refusal(message.error)); return; }
    if (message.type === 'stream') {
      if (!isStream(handle)) {
        discard(handle);
        violation('a standard stream arrived without a connected socket');
      } else if (!entry.control.attachStream(String(message.stream), handle)) {
        violation('unexpected standard stream');
      }
      return;
    }
    discard(handle);
    if (message.type === 'exit') {
      const code = Number.isInteger(message.code) ? message.code : null;
      const signal = typeof message.signal === 'string' ? providerText(message.signal) : null;
      entry.control.exit(code, signal);
      return;
    }
    if (message.type === 'failure') { entry.control.fail(failed(message.error)); return; }
    violation('unknown process message');
  }

  const onMessage = (message, handle) => {
    if (failure) { discard(handle); return; }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      discard(handle);
      return violation('malformed message');
    }
    if (message.type === 'hello') { discard(handle); return onHello(message); }
    if (!ready) { discard(handle); return violation('message before the handshake completed'); }
    if (message.type === 'result') return onResult(message, handle);
    if (message.type === 'failure' && message.process === undefined) {
      discard(handle);
      return fail(failed(message.error));
    }
    return onProcessMessage(message, handle);
  };
  const onDisconnect = () => fail(providerError('Execution provider connection closed.'));
  channel.on('message', onMessage);
  channel.on('disconnect', onDisconnect);
  channel.on('error', sendFailed);
  handshakeTimer = setTimeout(() => fail(providerError('Execution provider did not answer the handshake.')),
    handshakeTimeoutMs);
  handshakeTimer.unref?.();
  transmit({ type: 'hello', protocol: PROVIDER_PROTOCOL, versions: [PROVIDER_PROTOCOL_VERSION] });

  function ask(type, params = {}, { expectHandle = false } = {}) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++lastRequest;
      const timer = setTimeout(() => {
        if (!requests.delete(id)) return;
        abandoned.add(id);
        reject(providerError(`Execution provider did not answer the ${type} request.`));
      }, requestTimeoutMs);
      timer.unref?.();
      requests.set(id, { resolve, reject, expectHandle, timer });
      send({ type, id, ...params });
    });
  }

  return {
    kind: 'protocol',
    protocol: Object.freeze({ name: PROVIDER_PROTOCOL, version: PROVIDER_PROTOCOL_VERSION }),

    start(request) {
      const wire = describeProcessRequest(request, { baseEnv });
      const id = ++lastProcess;
      const graceMs = wire.lifecycle.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
      const { child, control } = createProviderProcess({
        id, stdin: wire.communication.stdin, graceMs,
        requestStop: (grace) => send({ type: 'stop', process: id, graceMs: grace })
      });
      // Only the answer to the start request is bounded; a running process has no lifetime limit here.
      const startTimer = setTimeout(() => {
        abandonedProcesses.add(id);
        send({ type: 'stop', process: id, graceMs: 0 });
        control.fail(providerError('Execution provider did not answer the start request.'));
      }, requestTimeoutMs);
      startTimer.unref?.();
      processes.set(id, { control, processClass: wire.processClass, startTimer });
      child.once('close', () => { clearTimeout(startTimer); processes.delete(id); });
      if (failure) control.fail(failure); else send({ type: 'start', process: id, request: wire });
      return child;
    },

    // The backends the image's tool inventory provides. Embedded ALA discovers backends only through this query.
    async inventory() {
      const { value } = await ask('inventory');
      if (!Array.isArray(value) || value.length > MAX_INVENTORY) {
        throw providerError('Execution provider returned an invalid backend inventory.');
      }
      const seen = new Set();
      for (const entry of value) {
        if (!entry || !AGENT_NAMES.includes(entry.name) || seen.has(entry.name)
            || (entry.version !== undefined && typeof entry.version !== 'string')) {
          throw providerError('Execution provider returned an invalid backend inventory.');
        }
        seen.add(entry.name);
      }
      return value.map(({ name, version }) => ({ name, ...(version ? { version: providerText(version) } : {}) }));
    },

    // A private temporary directory inside the workload view, as a virtual path.
    async tempdir() {
      const { value } = await ask('tempdir');
      const location = value?.path;
      if (virtualPathProblem(location) || location === '/') {
        throw providerError('Execution provider returned an invalid temporary directory.');
      }
      return location;
    },

    // One connected stream to a service of the same execution: a loopback port the process announced, or a Unix
    // socket path in its runtime directory. Used as the OpenCode HTTP connection factory.
    async connect({ process: child, host = '127.0.0.1', port, path = null }) {
      const entry = processes.get(child?.providerId);
      if (!entry || entry.processClass !== 'service') {
        throw providerError('A connection requires a running execution-provider service.');
      }
      let endpoint;
      if (path !== null) {
        if (virtualPathProblem(path)) throw providerError('Execution-provider socket path is invalid.');
        endpoint = { kind: 'unix-socket', path };
      } else {
        if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw providerError('Execution-provider services are reachable only on a loopback port.');
        }
        endpoint = { kind: 'loopback-port', host, port };
      }
      const { handle } = await ask('connect', { process: child.providerId, endpoint }, { expectHandle: true });
      if (!isStream(handle)) {
        discard(handle);
        throw providerError('Execution provider returned an invalid connection.');
      }
      return handle;
    },

    // Ends the channel. Processes still running are asked to stop first; the supervisor ends the rest with this
    // invocation's orchestration domain.
    async close() {
      if (closed) return;
      closed = true;
      // Nothing but the handshake may leave the client before the provider's hello.
      if (ready && !failure) for (const id of processes.keys()) transmit({ type: 'stop', process: id, graceMs: 0 });
      fail(providerError('Execution provider connection closed.'));
      channel.off?.('message', onMessage);
      channel.off?.('disconnect', onDisconnect);
      // A write error can still arrive after the channel is closed. The handler stays attached (it only no-ops once
      // the client has failed) because an 'error' event without a listener would end the process.
      if (channel.connected) channel.disconnect?.();
    }
  };
}
