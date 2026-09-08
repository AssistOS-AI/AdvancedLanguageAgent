import { randomBytes } from 'node:crypto';

import { createPermissionRequestManager, validatePermissionMode } from '../permission-requests.mjs';
import { appendBoundedTail } from './streaming.mjs';
import { consumeOpenCodeEvents } from './opencode-server.mjs';

export function openCodePermissionRules(mode, websearch) {
  validatePermissionMode(mode);
  return [
    { permission: '*', pattern: '*', action: mode === 'full-access' ? 'allow' : 'ask' },
    ...(!websearch ? ['websearch', 'webfetch'] : []).map((permission) => ({ permission, pattern: '*', action: 'deny' })),
    ...['question', 'plan_enter', 'plan_exit'].map((permission) => ({ permission, pattern: '*', action: 'deny' }))
  ];
}

function nativeModel(model) {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error('OpenCode model must use provider/model format.');
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function nativeErrorMessage(error) {
  const message = error?.data?.message || error?.message || error?.name || 'native error';
  return String(message).slice(0, 2048);
}

export async function executeOpenCodeTurn(server, input) {
  const { continuation, prompt, model, websearch, onSession, onVisibleText } = input;
  const permissionMode = input.permissionMode ?? 'full-access';
  const permissionRequests = input.permissionRequests ?? createPermissionRequestManager();
  const cancelled = new AbortController();
  const lifetime = AbortSignal.any([server.signal, cancelled.signal]);
  let sessionID = continuation?.sessionId;
  const owned = new Set();
  const foreign = new Set();
  const pending = new Map();
  const seenPermissions = new Set();
  const jobs = new Set();
  // Match OpenCode's ascending ID timestamp layout: native history is ordered by these identifiers.
  const timestamp = ((BigInt(Date.now()) << 12n) + 1n).toString(16).slice(-12).padStart(12, '0');
  const messageID = `msg_${timestamp}${randomBytes(7).toString('hex')}`;
  const assistants = new Set();
  const parts = new Map();
  let submitted = false;
  let workSeen = false;
  let idle = false;
  let finished = false;
  let interval;
  let streamTask;
  let resolveFinal;
  let rejectFinal;
  const final = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
  final.catch(() => {});
  const fail = (error) => { rejectFinal(error); cancelled.abort(error); };
  const interrupt = () => {
    const error = new Error('OpenCode execution was interrupted.');
    error.name = 'AbortError';
    fail(error);
  };
  const launch = (operation) => {
    const job = Promise.resolve().then(operation);
    jobs.add(job);
    job.catch(fail).finally(() => jobs.delete(job));
  };
  const request = (path, options = {}) => server.request(path, { ...options, signal: lifetime });
  const sessionPath = (id = sessionID) => `/session/${encodeURIComponent(id)}`;
  const belongs = async (id, visiting = new Set()) => {
    if (owned.has(id)) return true;
    if (!id || foreign.has(id) || visiting.has(id)) return false;
    visiting.add(id);
    const session = await request(sessionPath(id));
    if (session.id !== id) throw new Error('OpenCode returned an inconsistent session identity.');
    if (session.parentID && await belongs(session.parentID, visiting)) { owned.add(id); return true; }
    foreign.add(id);
    return false;
  };
  const dismiss = (id) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    permissionRequests.cancel(entry.host.id, 'backend-resolved');
  };
  const ask = async (native) => {
    if (seenPermissions.has(native.id) || !await belongs(native.sessionID)) return;
    if (seenPermissions.has(native.id)) return;
    seenPermissions.add(native.id);
    if (typeof native.permission !== 'string' || !Array.isArray(native.patterns) || !Array.isArray(native.always)) {
      throw new Error('OpenCode returned an invalid native permission request.');
    }
    const choices = [
      { id: 'allow-once', label: 'Allow once', description: 'Approve this native request only.' },
      { id: 'allow-session', label: 'Allow for this server session',
        description: `Native remembered patterns: ${native.always.join(', ') || '(none)'}` },
      { id: 'deny', label: 'Reject', description: 'Deny this native operation.' }
    ];
    const host = permissionRequests.request({
      agent: 'opencode', method: 'permission.asked', title: `OpenCode: ${native.permission}`,
      message: native.patterns.join('\n'), detail: {
        permission: native.permission, patterns: native.patterns, always: native.always, metadata: native.metadata
      }, options: choices
    }, { signal: lifetime, onCancel: (reason) => { if (reason !== 'control-unavailable') interrupt(); } });
    const entry = { host };
    pending.set(native.id, entry);
    const choice = await host;
    if (pending.get(native.id) !== entry || lifetime.aborted) return;
    pending.delete(native.id);
    const reply = { 'allow-once': 'once', 'allow-session': 'always', deny: 'reject' }[choice] ?? 'reject';
    await request(`/permission/${encodeURIComponent(native.id)}/reply`, { method: 'POST', body: { reply } });
  };
  const readFinal = async () => {
    if (!submitted || !workSeen || !idle || finished) return;
    const messages = await request(`${sessionPath()}/message`);
    if (!Array.isArray(messages)) throw new Error('OpenCode returned invalid session messages.');
    const matching = messages.filter(({ info }) => info?.role === 'assistant' && info.parentID === messageID);
    const last = matching.at(-1);
    if (!last?.info?.time?.completed) return;
    if (last.info.error) throw new Error(`OpenCode execution failed: ${nativeErrorMessage(last.info.error)}`);
    if (!last.info.finish || ['tool-calls', 'unknown'].includes(last.info.finish)) return;
    const outputText = appendBoundedTail('', (last.parts ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')).trim();
    if (!outputText) throw new Error('OpenCode completed without a final response.');
    finished = true;
    resolveFinal({ outputText, continuation: { sessionId: sessionID } });
  };
  const onEvent = async (event) => {
    const p = event.properties ?? {};
    if (event.type === 'session.created' && owned.has(p.info?.parentID)) owned.add(p.info.id);
    if (event.type === 'permission.replied') {
      seenPermissions.add(p.requestID);
      dismiss(p.requestID);
    }
    if (event.type === 'permission.asked' && submitted) launch(() => ask(p));
    if (event.type === 'question.asked' && submitted && await belongs(p.sessionID)) {
      throw new Error('OpenCode requested unsupported native question input; execution cancelled.');
    }
    if (!submitted || (p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID) !== sessionID) return;
    if (event.type === 'session.error') throw new Error(`OpenCode session failed: ${nativeErrorMessage(p.error)}`);
    if (event.type === 'message.updated') {
      const info = p.info;
      if (info?.id === messageID || (info?.role === 'assistant' && info.parentID === messageID)) {
        workSeen = true;
        idle = false;
        if (info.role === 'assistant') assistants.add(info.id);
      }
    }
    if (event.type === 'message.part.updated' && assistants.has(p.part?.messageID)) {
      const part = p.part;
      const text = part.type === 'text' ? part.text : part.type === 'tool' ? part.state?.output : null;
      if (typeof text === 'string') {
        const previous = parts.get(part.id) ?? '';
        const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
        parts.set(part.id, text);
        if (delta) onVisibleText?.(delta);
      }
    }
    if (event.type === 'message.part.delta' && assistants.has(p.messageID) && p.field === 'text') {
      parts.set(p.partID, (parts.get(p.partID) ?? '') + p.delta);
      onVisibleText?.(p.delta);
    }
    if (event.type === 'session.status') {
      idle = workSeen && p.status?.type === 'idle';
      if (idle) await readFinal();
    }
    if (event.type === 'session.idle' && workSeen) { idle = true; await readFinal(); }
  };
  const reconcile = async () => {
    const existing = new Map(pending);
    const list = await request('/permission');
    if (!Array.isArray(list)) throw new Error('OpenCode returned an invalid permission list.');
    const active = new Set(list.map((entry) => entry.id));
    for (const [id, entry] of existing) {
      if (!active.has(id) && pending.get(id) === entry) dismiss(id);
    }
    for (const native of list) launch(() => ask(native));
    await readFinal();
  };
  try {
    // Subscribe before session setup/prompting; the reader runs continuously while HTTP calls and UI choices await.
    const events = await request('/event', { stream: true });
    streamTask = consumeOpenCodeEvents(events, onEvent);
    streamTask.catch((error) => { if (!finished) fail(error); });
    let session;
    if (sessionID) {
      session = await request(sessionPath());
      if (session.id !== sessionID) throw new Error('OpenCode did not restore the requested native session.');
      session = await request(sessionPath(), { method: 'PATCH', body: {
        permission: openCodePermissionRules(permissionMode, websearch)
      } });
      if (session.id !== sessionID) throw new Error('OpenCode changed the requested native session during policy update.');
    } else {
      session = await request('/session', { method: 'POST', body: {
        permission: openCodePermissionRules(permissionMode, websearch)
      } });
      sessionID = session?.id;
      if (typeof sessionID !== 'string' || !sessionID.startsWith('ses')) {
        throw new Error('OpenCode created a session without a valid native identifier.');
      }
    }
    owned.add(sessionID);
    await onSession?.({ sessionId: sessionID });
    const requiredRules = openCodePermissionRules(permissionMode, websearch);
    const effective = session.permission?.slice(-requiredRules.length);
    if (!Array.isArray(effective) || requiredRules.some((rule, index) => (
      effective[index]?.permission !== rule.permission || effective[index]?.pattern !== rule.pattern
      || effective[index]?.action !== rule.action
    ))) {
      throw new Error(`OpenCode refused the requested ${permissionMode} session permission policy.`);
    }
    const body = { messageID, parts: [{ type: 'text', text: prompt }],
      ...(model ? { model: nativeModel(model) } : {}) };
    submitted = true;
    await request(`${sessionPath()}/prompt_async`, { method: 'POST', body });
    let reconciling = false;
    interval = setInterval(() => {
      if (reconciling || finished || lifetime.aborted) return;
      reconciling = true;
      launch(async () => { try { await reconcile(); } finally { reconciling = false; } });
    }, 500);
    await reconcile();
    return await Promise.race([final, server.failure, new Promise((resolve, reject) => {
      if (lifetime.aborted) reject(lifetime.reason);
      else lifetime.addEventListener('abort', () => reject(lifetime.reason), { once: true });
    })]);
  } catch (error) {
    if (sessionID) error.continuation = { sessionId: sessionID };
    throw error;
  } finally {
    clearInterval(interval);
    for (const id of pending.keys()) dismiss(id);
    cancelled.abort(new Error('OpenCode turn closed.'));
    if (!finished && sessionID) {
      await Promise.all([...new Set([sessionID, ...owned])].map((id) => server.request(`${sessionPath(id)}/abort`, {
        method: 'POST', signal: AbortSignal.timeout(3000)
      }).catch(() => {})));
    }
    await Promise.allSettled([...jobs, ...(streamTask ? [streamTask] : [])]);
  }
}
