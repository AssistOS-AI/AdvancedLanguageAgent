import { randomUUID } from 'node:crypto';

import { ALAError, EXIT_CODES } from './errors.mjs';

export function validatePermissionMode(mode) {
  if (!['ask-for-approval', 'full-access'].includes(mode)) {
    throw new ALAError('--permissions must be ask-for-approval or full-access.', EXIT_CODES.usage);
  }
  return mode;
}

export function createPermissionRequestManager({ eventSink = null, logger = null } = {}) {
  const pending = new Map();
  let replyCapable = false;
  const diagnostic = (message) => {
    if (logger?.warn) logger.warn(message);
    else process.stderr.write(`[warning] ${message}\n`);
  };
  const rejectResponse = (message) => {
    diagnostic(message);
    throw new ALAError(message, EXIT_CODES.input);
  };
  const notifyCancellation = (callback, reason) => {
    if (!callback) return;
    try {
      Promise.resolve(callback(reason)).catch((error) => diagnostic(`Native request cancellation failed: ${error.message}`));
    } catch (error) { diagnostic(`Native request cancellation failed: ${error.message}`); }
  };
  const settle = (id, optionId, reason) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve(optionId);
    eventSink?.({ type: 'coding-agent-request-resolved', id, reason });
    if (optionId === null && reason !== 'backend-resolved') notifyCancellation(entry.onCancel, reason);
    return true;
  };

  return {
    get replyCapable() { return replyCapable; },
    setReplyCapability(enabled) {
      replyCapable = enabled === true && typeof eventSink === 'function';
      if (!replyCapable) this.cancelAll('cancelled');
    },
    request({ agent, method, title, message, detail, options }, { signal, onCancel } = {}) {
      if (![agent, method, title, message].every((value) => typeof value === 'string')
          || !Array.isArray(options) || options.length === 0) {
        throw new ALAError('Invalid native permission request.', EXIT_CODES.execution);
      }
      const optionIds = new Set();
      const choices = options.map(({ id, label, description }) => {
        if (typeof id !== 'string' || !id || optionIds.has(id) || typeof label !== 'string'
            || (description !== undefined && typeof description !== 'string')) {
          throw new ALAError('Invalid native permission choices.', EXIT_CODES.execution);
        }
        optionIds.add(id);
        return { id, label, ...(description !== undefined ? { description } : {}) };
      });
      const id = randomUUID();
      let resolve;
      const result = new Promise((done) => { resolve = done; });
      // Backends retain this opaque handle to dismiss requests resolved by the native server.
      Object.defineProperty(result, 'id', { value: id });
      if (!replyCapable || signal?.aborted) {
        if (!replyCapable) diagnostic('Interactive approval requires a control-capable host; operation declined.');
        notifyCancellation(onCancel, signal?.aborted ? 'cancelled' : 'control-unavailable');
        resolve(null);
        return result;
      }
      const abort = () => settle(id, null, 'cancelled');
      pending.set(id, { optionIds, resolve, signal, abort, onCancel });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        eventSink({ type: 'coding-agent-request', id, agent, kind: 'permission', method, title, message,
          ...(detail !== undefined ? { detail } : {}), options: choices });
      } catch (error) {
        settle(id, null, 'cancelled');
        throw error;
      }
      return result;
    },
    resolve(response) {
      if (!response || typeof response !== 'object' || Array.isArray(response)
          || typeof response.id !== 'string'
          || Object.keys(response).some((key) => !['type', 'id', 'optionId', 'cancelled'].includes(key))
          || (Object.hasOwn(response, 'type') && response.type !== 'interaction-response')) {
        return rejectResponse('Invalid interaction response.');
      }
      const hasOption = Object.hasOwn(response, 'optionId');
      const hasCancellation = Object.hasOwn(response, 'cancelled');
      if (hasOption === hasCancellation || (hasOption && typeof response.optionId !== 'string')
          || (hasCancellation && response.cancelled !== true)) {
        return rejectResponse('Interaction response requires exactly one optionId or cancelled:true.');
      }
      const entry = pending.get(response.id);
      if (!entry) return rejectResponse(`Unknown or stale interaction response: ${response.id}`);
      if (hasOption && !entry.optionIds.has(response.optionId)) {
        return rejectResponse(`Unadvertised option for interaction response: ${response.id}`);
      }
      return settle(response.id, hasOption ? response.optionId : null, hasOption ? 'answered' : 'cancelled');
    },
    cancel(id, reason = 'cancelled') {
      if (!['cancelled', 'expired', 'backend-resolved'].includes(reason)) {
        throw new ALAError(`Invalid native request resolution reason: ${reason}`, EXIT_CODES.execution);
      }
      return settle(id, null, reason);
    },
    cancelAll(reason = 'cancelled') {
      const resolution = ['expired', 'backend-resolved'].includes(reason) ? reason : 'cancelled';
      for (const id of pending.keys()) settle(id, null, resolution);
    }
  };
}
