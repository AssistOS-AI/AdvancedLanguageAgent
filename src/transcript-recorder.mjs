import { normalizeResult } from './output.mjs';

const FLUSH_BYTES = 64 * 1024;

// Records one turn of a persistent session. Streamed coding-agent output is
// buffered per output stream and appended as one record when that output
// completes, another stream starts, or the turn ends.
export function createTranscriptRecorder(sessionState, turnId) {
  const started = Date.now();
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const { outputKind, outputId, text, complete } = pending;
    pending = null;
    if (text) sessionState.append('agent-message', { turnId, outputKind, ...(outputId ? { outputId } : {}), text, ...(complete ? { complete } : {}) });
  };
  return {
    user(text) { flush(); return sessionState.append('user', { turnId, text: String(text) }); },
    observe(event) {
      if (event.type === 'coding-agent-message') {
        const outputKind = event.outputKind === 'assistant' ? 'assistant' : 'output';
        const outputId = typeof event.outputId === 'string' ? event.outputId : null;
        if (pending && (pending.outputKind !== outputKind || pending.outputId !== outputId)) flush();
        pending ??= { outputKind, outputId, text: '', complete: false };
        pending.text += String(event.message || '');
        if (event.outputComplete) { pending.complete = true; flush(); }
        else if (pending.text.length >= FLUSH_BYTES) flush();
      } else if (event.type === 'agentlib-tool') {
        flush();
        sessionState.append('tool', { turnId, tool: event.tool, reason: event.reason });
      }
    },
    async finish({ result = null, status, error = null }) {
      flush();
      // The same text ALA writes to stdout for this result.
      if (result !== null && result !== undefined) sessionState.append('final', { turnId, text: normalizeResult(result) });
      return sessionState.append('turn-end', { turnId, status, durationMs: Date.now() - started, ...(error ? { error } : {}) });
    }
  };
}
