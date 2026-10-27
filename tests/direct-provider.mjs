import { spawn } from 'node:child_process';

// Test-only execution provider that runs a fixture executable directly, with the same environment merge the
// Bubblewrap provider applies. Production code has no such route: ALA starts a process only through the provider
// its caller selects. Tests that exercise adapters and protocols against fake CLIs inject this provider.
export function directProvider() {
  return {
    kind: 'direct-test',
    start({ binary, args, cwd, env = process.env, stdio }) {
      const executionEnv = { ...process.env, ...env };
      delete executionEnv.NODE_TEST_CONTEXT;
      return spawn(binary, args, { cwd, env: executionEnv, stdio });
    },
    async close() {}
  };
}

export function directSandbox(extra = {}) {
  return { provider: directProvider(), ...extra };
}
