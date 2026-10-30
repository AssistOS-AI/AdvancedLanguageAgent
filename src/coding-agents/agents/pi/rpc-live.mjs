import fs from 'node:fs/promises';
import path from 'node:path';

import { checkAbort } from '../../process.mjs';
import { openJsonChannel } from '../../json-channel.mjs';
import { createPiEventParser } from './runner.mjs';
import { requirePiVersion } from './version.mjs';

// The Pi family (Pi, OMP) shares one live RPC protocol. Releases differ in
// the turn-settled event name and may lack clear_queue, so both settled
// signals are accepted and queue clearing stays best-effort before abort.
function piFamilySettled(event) {
  return event.type === 'agent_settled' || event.type === 'session_settled';
}

export function createPiFamilyLiveRunner({ label, sessionLabel, rpcArguments, nativeContinuation }) {
  return async function runPiFamilyLive(input) {
    checkAbort(input.signal);
    await requirePiVersion(input);
    const sessionDir = `${input.workspace}/.ala-${sessionLabel}-sessions`;
    await fs.mkdir(path.join(input.hostWorkspace, `.ala-${sessionLabel}-sessions`), { recursive: true, mode: 0o700 });
    const previous = nativeContinuation.resumeValue(input);
    if (input.continuation && !previous) throw new Error(`${label} continuation has no resumable session.`);
    if (previous) await nativeContinuation.validateResumeValue(previous, sessionDir, input);
    const rpc = openJsonChannel(input, rpcArguments({ sessionDir, previous, model: input.model, effort: input.effort }));
    const parser = createPiEventParser({ onText: input.onVisibleText });
    rpc.events.on('event', (event) => parser.push(Buffer.from(`${JSON.stringify(event)}\n`)));
    let cancelTimer;
    const abort = () => {
      cancelTimer ||= setTimeout(() => { void rpc.close(); }, 1500);
      void rpc.request({ type: 'clear_queue' }).catch(() => {})
        .then(() => rpc.request({ type: 'abort' }).catch(() => {}));
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const state = await rpc.request({ type: 'get_state' });
      if (input.effort && state.thinkingLevel !== input.effort) {
        throw new Error(`${label} did not apply the requested thinking level: ` + input.effort);
      }
      const continuation = nativeContinuation.fromState(state);
      if (!continuation) throw new Error(`${label} did not expose a persistent session.`);
      if (previous && !nativeContinuation.matches(state, input.continuation)) {
        throw new Error(`${label} did not restore the requested native session.`);
      }
      await input.onSession?.(continuation);
      checkAbort(input.signal);
      const complete = rpc.wait(piFamilySettled);
      await rpc.request({ type: 'prompt', message: input.prompt });
      if (input.signal?.aborted) abort();
      input.setMessageHandler?.(async (message) => {
        await rpc.request({ type: 'steer', message });
        return { delivery: 'delivered' };
      });
      await complete;
      parser.finish();
      checkAbort(input.signal);
      if (parser.errorMessage()) throw new Error(parser.errorMessage());
      if (!parser.finalText()) throw new Error(`${label} completed without a final assistant message.`);
      return { outputText: parser.finalText(), continuation };
    } finally {
      clearTimeout(cancelTimer);
      input.setMessageHandler?.(null);
      input.signal?.removeEventListener('abort', abort);
      await rpc.close();
    }
  };
}
