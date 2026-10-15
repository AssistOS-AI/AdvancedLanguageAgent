import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const announceBinary = fileURLToPath(new URL('./opencode-announce.mjs', import.meta.url));
const serverFixture = fileURLToPath(new URL('./opencode-server.mjs', import.meta.url));

// The OpenAPI document that requireOpenCodeApi accepts, served by the real fake OpenCode so it cannot drift.
export async function loadApiDocument() {
  const root = await mkdtemp(join(tmpdir(), 'ala-opencode-doc-'));
  await writeFile(join(root, 'fixture-options.json'), JSON.stringify({ anyDirectory: true }));
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: 'doc', OPENCODE_CONFIG_CONTENT: '{}' };
  const child = spawn(serverFixture, [], { cwd: root, env });
  try {
    let output = '';
    for await (const chunk of child.stdout) {
      output += chunk;
      const match = output.match(/listening on (http:\/\/\S+)/u);
      if (match) {
        const response = await fetch(`${match[1]}/doc`, {
          headers: { authorization: `Basic ${Buffer.from('opencode:doc').toString('base64')}` }
        });
        return await response.json();
      }
    }
    throw new Error('fake OpenCode never announced its origin');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'close');
    await rm(root, { recursive: true, force: true });
  }
}

export async function waitFor(predicate, message, limit = 3000) {
  for (let waited = 0; waited < limit; waited += 10) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${message}`);
}

// A loopback HTTP origin that outlives the fake OpenCode processes, like a well-known port that consecutive
// OpenCode servers re-bind. Every accepted socket is stamped with the epoch in force when it connected.
// A request that arrives on a socket from an older epoch is reset, exactly as a connection that an earlier,
// now dead, server owned. `handlers` maps a path to (request, response, socket) for custom behaviour.
export async function createOrigin(context, { api, handlers = {} } = {}) {
  let epoch = 1;
  const sockets = [];
  const requests = [];
  const server = createServer(async (request, response) => {
    const { socket } = request;
    const entry = sockets.find((candidate) => candidate.socket === socket);
    const url = new URL(request.url, 'http://127.0.0.1');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ path: url.pathname, method: request.method, headers: request.headers, search: url.search,
      raw, epoch: entry.epoch, socket });
    if (entry.epoch !== epoch) { socket.resetAndDestroy(); return; }
    if (handlers[url.pathname]) { await handlers[url.pathname](request, response, entry); return; }
    const json = (data) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (url.pathname === '/global/health') json({ healthy: true, version: '1.15.13' });
    else if (url.pathname === '/doc') json(api);
    else { response.writeHead(404); response.end(); }
  });
  server.keepAliveTimeout = 60_000;
  server.on('connection', (socket) => {
    const entry = { socket, epoch, closed: false };
    sockets.push(entry);
    socket.on('close', () => { entry.closed = true; });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    for (const { socket } of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });
  const root = await mkdtemp(join(tmpdir(), 'ala-opencode-origin-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return {
    port: server.address().port, root, workspace, sockets, requests,
    nextEpoch() { epoch += 1; return epoch; },
    // The input for startOpenCodeServer: the announce binary points at this origin.
    serverInput: () => ({ binary: announceBinary, workspace, websearch: false,
      env: { HOME: root, OPENCODE_FIXTURE_PORT: String(server.address().port) } })
  };
}
