const basicDecisions = {
  accept: ['Allow once', 'Approve this operation.'],
  acceptForSession: ['Allow for native session', 'Use the native session-scoped grant.'],
  decline: ['Deny', 'Decline this operation and continue the turn.'],
  cancel: ['Cancel turn', 'Decline this operation and interrupt the turn.']
};

function decisionChoice(decision, index, fileChange) {
  const id = `choice-${index}`;
  if (typeof decision === 'string' && basicDecisions[decision]) {
    const [label, description] = basicDecisions[decision];
    return { id, label, description, result: { decision } };
  }
  if (!fileChange && decision && typeof decision === 'object' && Object.keys(decision).length === 1) {
    const exec = decision.acceptWithExecpolicyAmendment?.execpolicy_amendment;
    if (Array.isArray(exec) && exec.length && exec.every((value) => typeof value === 'string')) {
      return { id, label: 'Allow with execution policy amendment', description: JSON.stringify(exec),
        result: { decision } };
    }
    const network = decision.applyNetworkPolicyAmendment?.network_policy_amendment;
    if (network && typeof network.host === 'string' && ['allow', 'deny'].includes(network.action)) {
      return { id, label: `Apply network ${network.action} rule`, description: JSON.stringify(network),
        result: { decision } };
    }
  }
  throw new Error('Codex advertised an unsupported approval decision.');
}

export function codexApprovalChoices(method, params) {
  if (method === 'item/permissions/requestApproval') {
    if (!params.permissions || typeof params.permissions !== 'object' || Array.isArray(params.permissions)) {
      throw new Error('Codex permission request has no valid requested profile.');
    }
    return [
      { id: 'deny', label: 'Deny', description: 'Grant no additional permissions.',
        result: { permissions: {}, scope: 'turn' } },
      ...['turn', 'session'].map((scope) => ({ id: scope, label: `Grant for native ${scope}`,
        description: JSON.stringify(params.permissions), result: { permissions: params.permissions, scope } }))
    ];
  }
  const fileChange = method === 'item/fileChange/requestApproval';
  if (!fileChange && method !== 'item/commandExecution/requestApproval') {
    throw new Error(`Unsupported Codex native request: ${method}. User input and elicitation are not approvals.`);
  }
  let decisions = params.availableDecisions;
  if (decisions === undefined || decisions === null) {
    decisions = Object.keys(basicDecisions);
    if (!fileChange && params.proposedExecpolicyAmendment) {
      decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } });
    }
    if (!fileChange) for (const amendment of params.proposedNetworkPolicyAmendments || []) {
      decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
    }
  }
  if (!Array.isArray(decisions) || !decisions.length) throw new Error('Codex advertised no approval choices.');
  return decisions.map((decision, index) => decisionChoice(decision, index, fileChange));
}

export function codexThreadPolicy(permissionMode = 'full-access') {
  if (!['full-access', 'ask-for-approval'].includes(permissionMode)) throw new Error('Invalid Codex permission mode.');
  return { approvalPolicy: permissionMode === 'ask-for-approval' ? 'untrusted' : 'never',
    approvalsReviewer: 'user', sandbox: 'danger-full-access' };
}

export function verifyCodexPolicy(thread, requested) {
  if (thread.approvalPolicy !== requested.approvalPolicy || thread.approvalsReviewer !== requested.approvalsReviewer
      || thread.sandbox?.type !== 'dangerFullAccess') {
    throw new Error(`Codex refused the requested native policy ${JSON.stringify(requested)}; effective policy: `
      + JSON.stringify({ approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer,
        sandbox: thread.sandbox }));
  }
}

export function attachCodexApprovals({ rpc, input, interrupt, fail }) {
  const pending = new Map();
  const items = new Map();
  const itemKey = (params) => JSON.stringify([params.threadId, params.turnId, params.itemId || params.item?.id]);
  const dismiss = (id, reason) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    input.permissionRequests?.cancel(entry.hostId, reason);
  };
  const clear = (reason = 'backend-resolved') => {
    for (const id of pending.keys()) dismiss(id, reason);
    items.clear();
  };
  const receiveEvent = (event) => {
    const params = event.params || {};
    if (event.method === 'item/started') items.set(itemKey(params), params.item);
    if (event.method === 'item/completed') items.delete(itemKey(params));
    if (event.method === 'serverRequest/resolved') {
      const entry = pending.get(params.requestId);
      if (entry?.threadId === params.threadId) dismiss(params.requestId, 'backend-resolved');
    }
    if (event.method === 'turn/completed') {
      for (const [id, entry] of pending) {
        if (entry.threadId === params.threadId && (!params.turn?.id || entry.turnId === params.turn.id)) {
          dismiss(id, 'backend-resolved');
        }
      }
      for (const key of items.keys()) {
        if (JSON.parse(key)[0] === params.threadId) items.delete(key);
      }
    }
  };
  const receiveRequest = async (request) => {
    const params = request.params || {};
    try {
      const choices = codexApprovalChoices(request.method, params);
      const detail = JSON.stringify({ ...params, item: items.get(itemKey(params)) }, null, 2);
      if (!input.permissionRequests) {
        const diagnostic = 'Interactive approval requires a control-capable host; operation declined.\n';
        if (input.onVisibleText) input.onVisibleText(diagnostic);
        else process.stderr.write(diagnostic);
        rpc.respond(request.id, request.method === 'item/permissions/requestApproval'
          ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' });
        interrupt();
        return;
      }
      const entry = { threadId: params.threadId, turnId: params.turnId, hostId: null };
      pending.set(request.id, entry);
      const result = input.permissionRequests.request({ agent: 'codex', method: request.method,
        title: request.method === 'item/fileChange/requestApproval' ? 'Codex file changes' : 'Codex permission request',
        message: params.reason || params.command || 'Review the native operation and requested scope.', detail,
        options: choices.map(({ id, label, description }) => ({ id, label, description })) },
      { signal: input.signal, onCancel: () => interrupt() });
      entry.hostId = result.id;
      // Native resolution can arrive synchronously while the host displays the request.
      if (!pending.has(request.id)) input.permissionRequests.cancel(result.id, 'backend-resolved');
      const optionId = await result;
      if (!pending.has(request.id)) return;
      pending.delete(request.id);
      const selected = choices.find((choice) => choice.id === optionId);
      const response = selected?.result || (request.method === 'item/permissions/requestApproval'
        ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' });
      rpc.respond(request.id, response);
      if (optionId === null || response.decision === 'cancel') interrupt();
    } catch (error) {
      dismiss(request.id, 'backend-resolved');
      try { rpc.respondError(request.id, { code: -32601, message: error.message }); } catch {}
      fail(error);
    }
  };
  const failure = () => clear();
  rpc.events.on('request', receiveRequest);
  rpc.events.on('event', receiveEvent);
  rpc.events.on('failure', failure);
  return { clear, close() {
    clear();
    rpc.events.off('request', receiveRequest);
    rpc.events.off('event', receiveEvent);
    rpc.events.off('failure', failure);
  } };
}
