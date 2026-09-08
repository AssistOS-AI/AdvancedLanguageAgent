import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { executionError, runProcess, spawnProcess } from './process.mjs';
import { createLineDecoder } from './streaming.mjs';

const PREREQUISITE = 'OpenCode requires version 1.15.10 or a compatible later unprefixed session/permission API; '
  + 'install a supported version or configure OPENCODE_BIN.';

export function requireOpenCodeVersion(value) {
  const match = String(value).trim().match(/^(?:opencode\s+)?(\d+)\.(\d+)\.(\d+)(?:\s|$)/u);
  if (!match || Number(match[1]) !== 1 || Number(match[2]) < 15
    || (Number(match[2]) === 15 && Number(match[3]) < 10)) throw new Error(PREREQUISITE);
  return match.slice(1, 4).join('.');
}

export function requireOpenCodeApi(document) {
  const paths = document?.paths;
  const required = [
    ['/global/health', 'get'], ['/event', 'get'], ['/session', 'post'], ['/session/{sessionID}', 'get'],
    ['/session/{sessionID}', 'patch'], ['/session/{sessionID}/prompt_async', 'post'],
    ['/session/{sessionID}/message', 'get'], ['/session/{sessionID}/abort', 'post'],
    ['/permission', 'get'], ['/permission/{requestID}/reply', 'post']
  ];
  const resolve = (schema) => schema?.$ref?.startsWith('#/components/schemas/')
    ? document.components?.schemas?.[schema.$ref.slice('#/components/schemas/'.length)] : schema;
  const body = (path, method) => resolve(paths?.[path]?.[method]?.requestBody?.content?.['application/json']?.schema);
  const permission = resolve(body('/session', 'post')?.properties?.permission);
  const update = resolve(body('/session/{sessionID}', 'patch')?.properties?.permission);
  const rule = resolve(permission?.items);
  const prompt = body('/session/{sessionID}/prompt_async', 'post');
  const reply = resolve(body('/permission/{requestID}/reply', 'post')?.properties?.reply);
  const response = (path) => resolve(paths?.[path]?.get?.responses?.['200']?.content?.['application/json']?.schema);
  const requests = response('/permission');
  const nativeRequest = resolve(requests?.items);
  const session = response('/session/{sessionID}');
  const messages = response('/session/{sessionID}/message');
  const message = resolve(messages?.items);
  const model = resolve(prompt?.properties?.model);
  if (required.some(([path, method]) => !paths?.[path]?.[method])
    || permission?.type !== 'array' || update?.type !== 'array'
    || !rule?.properties?.permission || !rule?.properties?.pattern
    || !['ask', 'allow', 'deny'].every((value) => resolve(rule.properties.action)?.enum?.includes(value))
    || !prompt?.properties?.messageID || !prompt?.properties?.parts
    || !model?.properties?.providerID || !model?.properties?.modelID
    || requests?.type !== 'array'
    || !['id', 'sessionID', 'permission', 'patterns', 'always'].every((key) => nativeRequest?.properties?.[key])
    || !session?.properties?.id || resolve(session?.properties?.permission)?.type !== 'array'
    || messages?.type !== 'array' || !message?.properties?.info || !message?.properties?.parts
    || !paths?.['/event']?.get?.responses?.['200']?.content?.['text/event-stream']
    || !['once', 'always', 'reject'].every((value) => reply?.enum?.includes(value))) {
    throw new Error(PREREQUISITE);
  }
}

export function openCodeEnvironment(env, websearch) {
  let overlay = {};
  if (env?.OPENCODE_CONFIG_CONTENT) {
    try { overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error('OPENCODE_CONFIG_CONTENT must contain a JSON object.'); }
    if (!overlay || Array.isArray(overlay) || typeof overlay !== 'object') {
      throw new Error('OPENCODE_CONFIG_CONTENT must contain a JSON object.');
    }
  }
  const permission = typeof overlay.permission === 'string'
    ? { '*': overlay.permission } : { ...overlay.permission };
  Object.assign(permission, { question: 'deny', plan_enter: 'deny', plan_exit: 'deny' });
  if (!websearch) Object.assign(permission, { websearch: 'deny', webfetch: 'deny' });
  return {
    ...env, OPENCODE_ENABLE_EXA: websearch ? '1' : '0',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...overlay, permission })
  };
}

export async function startOpenCodeServer(input) {
  const { binary, workspace, sandbox, signal, websearch } = input;
  const env = openCodeEnvironment(input.env, websearch);
  const versionResult = await runProcess({
    binary, args: ['--version'], cwd: workspace, env, sandbox,
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])
  });
  if (versionResult.code !== 0) throw executionError('OpenCode version check', versionResult);
  const version = requireOpenCodeVersion(versionResult.stdout);
  const password = randomBytes(32).toString('base64url');
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const child = spawnProcess({
    binary, args: ['serve', '--hostname', '127.0.0.1', '--port', '0'], cwd: workspace, sandbox,
    env: { ...env, OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stopping = false;
  let base;
  let resolveUrl;
  const urlReady = new Promise((resolve) => { resolveUrl = resolve; });
  const failed = new AbortController();
  const failure = new Promise((resolve, reject) => {
    failed.signal.addEventListener('abort', () => reject(failed.signal.reason), { once: true });
  });
  failure.catch(() => {});
  const fail = (error) => { if (!stopping) failed.abort(error); };
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  child.once('error', () => { fail(new Error('OpenCode server failed to start.')); resolveExit(); });
  child.once('close', (code) => {
    fail(new Error(`OpenCode server exited unexpectedly (${code}).`));
    resolveExit();
  });
  const decode = () => createLineDecoder((line) => {
    const match = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').match(/server listening on (http:\/\/\S+)/u);
    if (!match || base) return;
    try {
      const url = new URL(match[1]);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.port === '0'
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('OpenCode server did not bind an authenticated loopback endpoint.');
      }
      base = url;
      resolveUrl();
    } catch (error) { fail(error); }
  });
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = decode();
    stream.on('data', decoder.push);
    stream.on('end', decoder.finish);
  }
  const lifetime = AbortSignal.any([failed.signal, ...(signal ? [signal] : [])]);
  const request = async (path, { method = 'GET', body, signal: requestSignal = lifetime, stream = false } = {}) => {
    const url = new URL(path, base);
    url.searchParams.set('directory', '/workspace');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('OpenCode HTTP request timed out.')), 15_000);
    try {
      const response = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.any([requestSignal, timeout.signal]),
        headers: { authorization, 'x-opencode-directory': '/workspace',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OpenCode ${method} ${path} failed (HTTP ${response.status}).`);
      }
      if (stream) return response;
      return response.status === 204 ? null : await response.json();
    } finally { clearTimeout(timer); }
  };
  const stop = async () => {
    stopping = true;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const startup = new AbortController();
  try {
    try {
      await Promise.race([urlReady, failure, delay(30_000, null, {
        signal: AbortSignal.any([lifetime, startup.signal])
      }).then(() => { throw new Error('OpenCode server did not announce a bound loopback URL.'); })]);
    } finally { startup.abort(); }
    const health = await request('/global/health');
    if (health?.healthy !== true || requireOpenCodeVersion(health.version) !== version) {
      throw new Error('OpenCode authenticated server version does not match the selected executable.');
    }
    requireOpenCodeApi(await request('/doc'));
    return { request, stop, failure, signal: lifetime };
  } catch (error) { await stop(); throw error; }
}

export async function consumeOpenCodeEvents(response, onEvent) {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new Error('OpenCode did not provide an SSE event stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let dataSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('OpenCode event stream closed before execution settled.');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4 * 1024 * 1024) throw new Error('OpenCode SSE record exceeded the output limit.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) await onEvent(JSON.parse(data.join('\n')));
          data = [];
          dataSize = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /u, '');
          data.push(value);
          dataSize += value.length;
        }
        if (dataSize > 4 * 1024 * 1024) {
          throw new Error('OpenCode SSE record exceeded the output limit.');
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
