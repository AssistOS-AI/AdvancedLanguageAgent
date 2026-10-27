import { spawn } from 'node:child_process';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { buildSandboxArgs, canMountPrivateProc, findBubblewrap } from './sandbox.mjs';

// The standalone provider: today's Bubblewrap launch, unchanged, behind the execution-provider interface. The
// capability probes run when the provider is constructed, which is where the coding-agent service ran them before,
// so a provider that is never selected never probes. `spawnImpl` and `capabilities` are test seams.
export function createBubblewrapProvider({ spawnImpl = spawn, capabilities = null } = {}) {
  const bwrap = capabilities ? capabilities.bwrap ?? null : findBubblewrap();
  const probed = {
    bwrap,
    privateProc: capabilities ? Boolean(capabilities.privateProc) : canMountPrivateProc(bwrap)
  };
  return {
    kind: 'bubblewrap',
    capabilities: Object.freeze({ ...probed }),
    start({ binary, args, cwd, env = process.env, stdio, sandbox }) {
      if (!sandbox) {
        throw new ALAError('Coding-agent processes must run inside the ALA Bubblewrap sandbox.', EXIT_CODES.execution);
      }
      const executionEnv = { ...process.env, ...env };
      delete executionEnv.NODE_TEST_CONTEXT;
      const launcher = sandbox.bwrap || probed.bwrap || findBubblewrap();
      return spawnImpl(launcher || '/usr/bin/bwrap', buildSandboxArgs({
        workspace: sandbox.hostWorkspace,
        workspaceTarget: sandbox.workspaceTarget,
        backend: sandbox.backend,
        binary,
        args,
        env: executionEnv,
        bwrap: launcher,
        privateProc: sandbox.privateProc ?? (probed.privateProc ? true : undefined),
        home: sandbox.home,
        folders: sandbox.folders,
        ignoredPaths: sandbox.ignoredPaths,
        chdir: cwd
      }), {
        cwd: sandbox.hostWorkspace,
        env: executionEnv,
        stdio
      });
    },
    async close() {}
  };
}
