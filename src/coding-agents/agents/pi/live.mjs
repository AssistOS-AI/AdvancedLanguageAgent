import fs from 'node:fs/promises';
import path from 'node:path';

import { createPiFamilyLiveRunner } from './rpc-live.mjs';

export const runPiLive = createPiFamilyLiveRunner({
  label: 'Pi',
  sessionLabel: 'pi',
  rpcArguments: ({ sessionDir, previous, model, effort }) => ['--mode', 'rpc', '--session-dir', sessionDir, '--approve',
    ...(previous ? ['--session', previous] : []), ...(model ? ['--model', model] : []),
    ...(effort ? ['--thinking', effort] : [])],
  nativeContinuation: {
    resumeValue: (input) => input.continuation?.sessionFile,
    async validateResumeValue(previous, sessionDir, input) {
      if (!previous.startsWith(`${sessionDir}/`) || path.basename(previous) !== previous.slice(sessionDir.length + 1)) {
        throw new Error('Invalid Pi session file.');
      }
      await fs.access(path.join(input.hostWorkspace, '.ala-pi-sessions', path.basename(previous)));
    },
    fromState: (state) => (state.sessionFile && state.sessionId)
      ? { sessionId: state.sessionId, sessionFile: state.sessionFile } : null,
    matches: (state, continuation) => state.sessionFile === continuation.sessionFile
      && state.sessionId === continuation.sessionId
  }
});
