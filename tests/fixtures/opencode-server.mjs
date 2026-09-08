#!/usr/bin/node
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('1.15.13\n');
  process.exit(0);
}
const body = (properties) => ({ requestBody: { content: { 'application/json': {
  schema: { type: 'object', properties }
} } } });
const response = (schema, type = 'application/json') => ({ responses: { 200: { content: { [type]: { schema } } } } });
const rules = { $ref: '#/components/schemas/PermissionRuleset' };
const api = {
  paths: {
    '/global/health': { get: {} }, '/event': { get: response({}, 'text/event-stream') },
    '/session': { post: body({ permission: rules }) },
    '/session/{sessionID}': {
      get: response({ properties: { id: { type: 'string' }, permission: rules } }), patch: body({ permission: rules })
    },
    '/session/{sessionID}/prompt_async': { post: body({
      messageID: { type: 'string' }, parts: { type: 'array' },
      model: { properties: { providerID: { type: 'string' }, modelID: { type: 'string' } } }
    }) },
    '/session/{sessionID}/message': {
      get: response({ type: 'array', items: { properties: { info: {}, parts: { type: 'array' } } } })
    },
    '/session/{sessionID}/abort': { post: {} },
    '/permission': { get: response({ type: 'array', items: { properties: {
      id: { type: 'string' }, sessionID: { type: 'string' }, permission: { type: 'string' },
      patterns: { type: 'array' }, always: { type: 'array' }
    } } }) },
    '/permission/{requestID}/reply': { post: body({ reply: { enum: ['once', 'always', 'reject'] } }) }
  },
  components: { schemas: {
    PermissionRuleset: { type: 'array', items: { $ref: '#/components/schemas/PermissionRule' } },
    PermissionRule: { properties: {
      permission: { type: 'string' }, pattern: { type: 'string' }, action: { $ref: '#/components/schemas/PermissionAction' }
    } },
    PermissionAction: { enum: ['allow', 'ask', 'deny'] }
  } }
};
const config = existsSync('fixture-options.json') ? JSON.parse(readFileSync('fixture-options.json')) : {};
if (config.incompatible) delete api.paths['/session/{sessionID}'].patch;
const log = (event) => appendFileSync('native-events.jsonl', `${JSON.stringify(event)}\n`);
const state = existsSync('native-state.json') ? JSON.parse(readFileSync('native-state.json')) : { sessions: {} };
let events;
let pending;
let active;
let messages = [];
const send = (type, properties) => events?.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
const save = () => writeFileSync('native-state.json', JSON.stringify(state));
const finish = (text) => {
  const info = { id: 'msg_assistant', sessionID: active.sessionID, role: 'assistant', parentID: active.messageID,
    time: { created: 1, completed: 2 }, finish: 'stop' };
  messages.push({ info, parts: [{ id: 'prt_text', messageID: info.id, type: 'text', text }] });
  send('message.updated', { info });
  send('message.part.updated', { sessionID: active.sessionID, part: messages.at(-1).parts[0] });
  send('session.status', { sessionID: active.sessionID, status: { type: 'idle' } });
};
const start = () => {
  send('message.updated', { info: { id: active.messageID, sessionID: active.sessionID, role: 'user' } });
  send('session.status', { sessionID: active.sessionID, status: { type: 'busy' } });
  if (active.prompt === 'provider-failure') {
    send('session.error', { sessionID: active.sessionID,
      error: { name: 'APIError', data: { message: 'Native provider authentication required' } } });
    return;
  }
  if (active.prompt === 'stream-failure') { events.end(); return; }
  if (active.prompt === 'historical-idle') { finish('current turn, not historical text'); return; }
  const policy = state.sessions[active.sessionID].permission
    .filter((rule) => ['*', 'edit'].includes(rule.permission)).at(-1);
  if (policy?.action === 'allow') {
    writeFileSync('scratch.txt', 'allowed mutation'); finish('mutation approved'); return;
  }
  const child = { id: 'ses_child', parentID: active.sessionID };
  state.sessions[child.id] = child;
  pending = { id: 'per_native', sessionID: child.id, permission: 'edit', patterns: ['scratch.txt'],
    metadata: { filepath: '/workspace/scratch.txt' }, always: ['*.txt'] };
  if (active.prompt !== 'missed-event') send('permission.asked', pending);
  if (active.prompt === 'backend-resolved') setTimeout(() => {
    pending = null;
    send('permission.replied', { requestID: 'per_native', sessionID: child.id, reply: 'reject' });
    finish('native request resolved elsewhere');
  }, 60);
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
  };
  if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`) {
    json({ error: 'Unauthorized' }, 401); return;
  }
  if (url.searchParams.get('directory') !== '/workspace' || req.headers['x-opencode-directory'] !== '/workspace') {
    json({ error: 'Incorrect sandbox directory' }, 400); return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = raw ? JSON.parse(raw) : null;
  if (url.pathname === '/global/health') { json({ healthy: true, version: '1.15.13' }); return; }
  if (url.pathname === '/doc') { json(api); return; }
  if (url.pathname === '/event') {
    events = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send('server.connected', {});
    send('session.status', { sessionID: 'ses_owned', status: { type: 'idle' } });
    return;
  }
  if (url.pathname === '/session' && req.method === 'POST') {
    state.sessions.ses_owned = { id: 'ses_owned', permission: config.refusePolicy ? [] : input.permission };
    save(); log({ type: 'create', permission: input.permission }); json(state.sessions.ses_owned); return;
  }
  if (url.pathname === '/permission') { json(pending ? [pending] : []); return; }
  if (url.pathname === '/permission/per_native/reply') {
    log({ type: 'reply', reply: input.reply });
    pending = null;
    if (input.reply !== 'reject') writeFileSync('scratch.txt', 'allowed mutation');
    send('permission.replied', { requestID: 'per_native', sessionID: 'ses_child', reply: input.reply });
    json(true); finish(input.reply === 'reject' ? 'mutation denied' : 'mutation approved'); return;
  }
  const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(.+))?$/u);
  if (!match) { json({}, 404); return; }
  const [, sessionID, operation] = match;
  if (!operation) {
    if (!state.sessions[sessionID]) { json({}, 404); return; }
    if (req.method === 'PATCH') {
      state.sessions[sessionID].permission = [...state.sessions[sessionID].permission, ...input.permission]; save();
      log({ type: 'update', sessionID, permission: input.permission });
    }
    json(state.sessions[sessionID]); return;
  }
  if (operation === 'message') { json(messages); return; }
  if (operation === 'abort') { pending = null; log({ type: 'abort', sessionID }); json(true); return; }
  if (operation === 'prompt_async') {
    if (!events || !existsSync('persisted-before-work')) { json({}, 409); return; }
    active = { sessionID, messageID: input.messageID, prompt: input.parts[0].text };
    log({ type: 'prompt', sessionID, model: input.model });
    messages = [{ info: { id: 'msg_old', role: 'assistant', parentID: 'msg_old_user',
      time: { completed: 1 }, finish: 'stop' }, parts: [{ type: 'text', text: 'historical answer' }] }];
    send('session.status', { sessionID, status: { type: 'idle' } });
    res.writeHead(204); res.end(); setTimeout(start, 40); return;
  }
  json({}, 404);
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync('server-address', `http://127.0.0.1:${server.address().port}`);
  log({ type: 'start', overlay: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) });
  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
});
process.on('SIGTERM', () => { log({ type: 'stop' }); process.exit(0); });
