import { createPiFamilyLiveRunner } from '../pi/rpc-live.mjs';

export const runOmpLive = createPiFamilyLiveRunner({
  label: 'OMP',
  sessionLabel: 'omp',
  rpcArguments: ({ sessionDir, previous, model, effort }) => ['--mode', 'rpc', '--session-dir', sessionDir, '--auto-approve',
    ...(previous ? ['--resume', previous] : []), ...(model ? ['--model', model] : []),
    ...(effort ? ['--thinking', effort] : [])],
  nativeContinuation: {
    resumeValue: (input) => input.continuation?.sessionId,
    async validateResumeValue(previous) {
      // OMP resumes by session identifier; identifiers never carry paths.
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(previous)) throw new Error('Invalid OMP session identifier.');
    },
    fromState: (state) => state.sessionId ? { sessionId: state.sessionId } : null,
    matches: (state, continuation) => state.sessionId === continuation.sessionId
  }
});
