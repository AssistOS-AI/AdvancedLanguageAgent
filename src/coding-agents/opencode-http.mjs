import http from 'node:http';
import { Readable } from 'node:stream';

// Statuses whose Response must not carry a body.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function transportError(error) {
  // The code is kept for diagnosis; the message never carries a URL, header or credential.
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  return new Error(`OpenCode HTTP connection failed (${code}).`, { cause: error });
}

function toHeaders(rawHeaders) {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) headers.append(rawHeaders[index], rawHeaders[index + 1]);
  return headers;
}

// One client belongs to one OpenCode server instance. Its sockets are private to that instance and `close()`
// destroys every one of them, so no connection can outlive its server or be reused by another server that
// binds the same loopback origin. The global fetch dispatcher is deliberately not used: it pools connections
// per origin for the whole process and OpenCode may bind the same port for consecutive servers.
export function createOpenCodeHttpClient() {
  const agent = new http.Agent({ keepAlive: true });
  let closed = false;

  // Resolves with a standard Response once headers arrive. A `signal` abort rejects with `signal.reason` before
  // the headers and errors the body stream with it afterwards, like fetch. Cancelling or aborting a body
  // destroys its socket instead of returning a half-read connection to the pool.
  const request = (url, { method = 'GET', headers = {}, body, signal } = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('OpenCode HTTP client is closed.')); return; }
    if (signal?.aborted) { reject(signal.reason); return; }
    const payload = body === undefined ? null : Buffer.from(body);
    const outgoing = http.request({
      agent, method, host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`,
      // node:http cannot decode a compressed body, and a missing Accept-Encoding allows any coding.
      headers: { accept: '*/*', ...headers, 'accept-encoding': 'identity',
        ...(payload ? { 'content-length': payload.length } : {}) }
    });
    let incoming = null;
    let settled = false;
    const onAbort = () => {
      const reason = signal.reason;
      if (incoming) incoming.destroy(reason);
      outgoing.destroy(reason);
      if (!settled) { settled = true; reject(reason); }
    };
    const release = () => signal?.removeEventListener('abort', onAbort);
    // These listeners stay for the lifetime of the exchange: close() may destroy the socket under a response
    // that is still being read, and an unhandled 'error' event would crash the process.
    outgoing.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(closed ? new Error('OpenCode HTTP client is closed.') : transportError(error));
    });
    outgoing.once('close', release);
    outgoing.once('response', (response) => {
      incoming = response;
      response.on('error', () => {});
      response.once('close', release);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        if (!settled) { settled = true; reject(new Error('OpenCode HTTP redirect refused.')); }
        return;
      }
      const encoding = response.headers['content-encoding']?.trim().toLowerCase();
      if (encoding && encoding !== 'identity') {
        // Destroying the unread response releases its socket instead of pooling a half-read connection.
        response.destroy();
        if (!settled) {
          settled = true;
          reject(new Error('OpenCode HTTP response used an unsupported content encoding.'));
        }
        return;
      }
      const nullBody = NULL_BODY_STATUSES.has(response.statusCode);
      if (nullBody) response.resume();
      settled = true;
      resolve(new Response(nullBody ? null : Readable.toWeb(response), {
        status: response.statusCode, headers: toHeaders(response.rawHeaders)
      }));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    outgoing.end(payload);
  });

  return {
    request,
    // Safe to call repeatedly. Requests issued afterwards fail instead of opening a new socket.
    close() { closed = true; agent.destroy(); }
  };
}
