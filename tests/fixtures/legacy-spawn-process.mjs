import { spawn } from 'node:child_process';

import { buildSandboxArgs, findBubblewrap } from '../../src/coding-agents/sandbox.mjs';

// The standalone launch exactly as it was before the execution-provider interface: `spawnProcess` copied verbatim from
// src/coding-agents/process.mjs lines 26-51 at the base revision 1d1cb673 (`git show 1d1cb673:src/coding-agents/process.mjs`).
// It is a reference for tests only and is never imported by production code.
export function legacySpawnProcess({ binary, args, cwd, env = process.env, stdio, sandbox = null }) {
  const executionEnv = { ...process.env, ...env };
  delete executionEnv.NODE_TEST_CONTEXT;
  if (!sandbox) {
    return spawn(binary, args, { cwd, env: executionEnv, stdio });
  }
  const bwrap = sandbox.bwrap || findBubblewrap();
  return spawn(bwrap || '/usr/bin/bwrap', buildSandboxArgs({
    workspace: sandbox.hostWorkspace,
    workspaceTarget: sandbox.workspaceTarget,
    backend: sandbox.backend,
    binary,
    args,
    env: executionEnv,
    bwrap,
    privateProc: sandbox.privateProc,
    home: sandbox.home,
    folders: sandbox.folders,
    ignoredPaths: sandbox.ignoredPaths,
    chdir: cwd
  }), {
    cwd: sandbox.hostWorkspace,
    env: executionEnv,
    stdio
  });
}
