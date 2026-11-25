import { randomBytes } from 'node:crypto';
import { createPermissionRequestManager } from '../../../permission-requests.mjs';
import { consumeOpenCodeEvents } from './server.mjs';
import { openCodeV2Model, openCodeV2Rules } from './v2-contract.mjs';
import { failureError } from '../../failure-reason.mjs';
import { openCodeFailure } from './failure.mjs';

// One owned foreground server per invocation. Session IDs remain the native IDs imported by OpenCode.
export async function executeOpenCodeV2Turn(server, input) {
  const controller = new AbortController();
  const signal = AbortSignal.any([server.signal, controller.signal]);
  const requests = input.permissionRequests ?? createPermissionRequestManager();
  const request = (path, options = {}) => server.request(path, { ...options, signal });
  let sessionID = input.continuation?.sessionId;
  const sessionPath = id => `/api/session/${encodeURIComponent(id || sessionID)}`;
  const permissions = openCodeV2Rules(input.permissionMode, input.websearch);
  const messageID = `msg_${Date.now().toString(16)}${randomBytes(10).toString('hex')}`;
  const owned = new Set();
  const pending = new Map();
  const jobs = new Set();
  let submitted = false;
  let finished = false;
  let stream;
  let resolveFinal, rejectFinal;
  const final = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
  final.catch(() => {});
  const fail = error => { rejectFinal(error); controller.abort(error); };
  const launch = operation => {
    const job = Promise.resolve().then(operation);
    jobs.add(job);
    job.catch(fail).finally(() => jobs.delete(job));
  };
  const belongs = async (id, seen = new Set()) => {
    if (owned.has(id)) return true;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const { data } = await request(sessionPath(id));
    if (data?.id !== id) throw new Error('OpenCode returned an inconsistent session identity.');
    if (data.parentID && await belongs(data.parentID, seen)) { owned.add(id); return true; }
    return false;
  };
  const dismiss = id => {
    const host = pending.get(id);
    if (host) { requests.cancel(host.id, 'backend-resolved'); pending.delete(id); }
  };
  const ask = async native => {
    if (!submitted || pending.has(native.id) || !await belongs(native.sessionID)) return;
    if (pending.has(native.id)) return;
    if (typeof native.action !== 'string' || !Array.isArray(native.resources)) {
      throw new Error('Invalid OpenCode V2 permission request.');
    }
    const host = requests.request({
      agent: 'opencode', method: 'permission.asked', title: `OpenCode: ${native.action}`,
      message: native.resources.join('\n'), detail: native,
      options: [{ id: 'allow-once', label: 'Allow once', description: 'Approve this request.' },
        ...(native.save?.length ? [{ id: 'allow-session', label: 'Always allow',
          description: `Save native patterns: ${native.save.join(', ')}` }] : []),
        { id: 'deny', label: 'Reject', description: 'Deny this operation.' }]
    }, { signal, onCancel: reason => {
      if (reason !== 'control-unavailable' && reason !== 'backend-resolved') {
        fail(new Error('OpenCode permission request cancelled.'));
      }
    } });
    pending.set(native.id, host);
    const choice = await host;
    if (pending.get(native.id) !== host || signal.aborted) return;
    pending.delete(native.id);
    await request(`${sessionPath(native.sessionID)}/permission/${encodeURIComponent(native.id)}/reply`, {
      method: 'POST', body: { decision: { 'allow-once': 'once', 'allow-session': 'always' }[choice] || 'reject' }
    });
  };
  const readFinal = async () => {
    // Walk back to this prompt, rather than returning a previous turn's final answer.
    let cursor;
    let last;
    do {
      const query = new URLSearchParams(cursor ? { cursor, limit: '100' } : { order: 'desc', limit: '100' });
      const page = await request(`${sessionPath()}/message?${query}`);
      if (!Array.isArray(page.data)) throw new Error('Invalid OpenCode V2 messages.');
      for (const message of page.data) {
        if (message.id === messageID) {
          if (!last || last.error || !last.time?.completed) throw new Error('OpenCode did not complete this prompt.');
          const outputText = last.content.filter(part => part.type === 'text').map(part => part.text).join('').trim();
          if (!outputText) throw new Error('OpenCode completed without a final response.');
          finished = true;
          resolveFinal({ outputText, continuation: { sessionId: sessionID } });
          return;
        }
        if (!last && message.type === 'assistant') last = message;
      }
      cursor = page.cursor?.next;
    } while (cursor);
    throw new Error('OpenCode did not persist the submitted prompt.');
  };
  try {
    if (sessionID) {
      const existing = await request(sessionPath());
      if (existing.data?.id !== sessionID) throw new Error('OpenCode did not restore the requested native session.');
      await request(sessionPath(), { method: 'PATCH', body: { permissions } });
    } else {
      const created = await request('/api/session', { method: 'POST', body: {
        location: { directory: server.workspace }, permissions, metadata: { client: 'ala' }
      } });
      sessionID = created.data?.id;
      if (typeof sessionID !== 'string' || !sessionID.startsWith('ses')) throw new Error('Invalid OpenCode session ID.');
    }
    owned.add(sessionID);
    await input.onSession?.({ sessionId: sessionID });
    const verified = (await request(sessionPath())).data;
    if (JSON.stringify(verified?.permissions) !== JSON.stringify(permissions)) {
      throw new Error('OpenCode refused the requested session permission policy.');
    }
    if (input.model) await request(`${sessionPath()}/model`, {
      method: 'POST', body: { model: openCodeV2Model(input.model, input.effort) }
    });
    const response = await request('/api/event', { stream: true });
    stream = consumeOpenCodeEvents(response, async event => {
      const data = event.data || {};
      if (event.type === 'permission.replied') dismiss(data.requestID);
      if (event.type === 'permission.asked') launch(() => ask(data));
      if (!submitted || data.sessionID !== sessionID) return;
      if (event.type === 'session.text.delta') input.onVisibleText?.(data.delta, {
        outputKind: 'assistant', outputId: data.assistantMessageID
      });
      if (event.type === 'session.text.ended') input.onVisibleText?.('', {
        outputKind: 'assistant', outputId: data.assistantMessageID, outputComplete: true
      });
      if (event.type === 'session.tool.success') {
        const text = data.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
        if (text) input.onVisibleText?.(text, { outputKind: 'output', outputId: data.id, outputComplete: true });
      }
      if (event.type === 'session.execution.failed') {
        throw failureError('OpenCode execution failed.', openCodeFailure(data.error));
      }
      if (event.type === 'session.execution.interrupted') throw new Error('OpenCode execution interrupted.');
      if (event.type === 'session.execution.succeeded') await readFinal();
    });
    stream.catch(error => { if (!finished) fail(error); });
    submitted = true;
    const admitted = await request(`${sessionPath()}/prompt`, { method: 'POST',
      body: { id: messageID, text: input.prompt, delivery: 'queue' } });
    if (admitted.data?.id !== messageID) throw new Error('OpenCode did not admit the submitted prompt.');
    return await Promise.race([final, server.failure, new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
  } catch (error) {
    if (sessionID) error.continuation = { sessionId: sessionID };
    throw error;
  } finally {
    for (const id of pending.keys()) dismiss(id);
    controller.abort(new Error('OpenCode turn closed.'));
    if (!finished && sessionID) await Promise.all([...owned].map(id => server.request(`${sessionPath(id)}/interrupt`, {
      method: 'POST', body: { resume: false }, signal: AbortSignal.timeout(3000)
    }).catch(() => {})));
    await Promise.allSettled([...jobs, ...(stream ? [stream] : [])]);
  }
}
