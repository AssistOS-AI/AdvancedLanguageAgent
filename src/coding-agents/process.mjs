import { spawn } from 'node:child_process';

import { buildSandboxArgs, findBubblewrap } from './sandbox.mjs';
import { ALAError, EXIT_CODES } from '../errors.mjs';

const OUTPUT_LIMIT = 4 * 1024 * 1024;

export function requireSandbox(sandbox) {
  if (!sandbox) {
    throw new ALAError(
      'Coding-agent processes must run inside the ALA Bubblewrap sandbox.',
      EXIT_CODES.execution
    );
  }
  return sandbox;
}

function appendLimited(current, chunk, limit = OUTPUT_LIMIT) {
  const next = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  if (next.length <= limit) return next.toString('utf8');
  let start = next.length - limit;
  while (start < next.length && (next[start] & 0xc0) === 0x80) start += 1;
  return next.subarray(start).toString('utf8');
}

export function spawnProcess({ binary, args, cwd, env = process.env, stdio, sandbox = null }) {
  const executionEnv = { ...process.env, ...env };
  delete executionEnv.NODE_TEST_CONTEXT;
  if (!sandbox) {
    return spawn(binary, args, { cwd, env: executionEnv, stdio });
  }
  const bwrap = sandbox.bwrap || findBubblewrap();
  return spawn(bwrap || '/usr/bin/bwrap', buildSandboxArgs({
    workspace: sandbox.hostWorkspace,
    backend: sandbox.backend,
    binary,
    args,
    mounts: sandbox.mounts,
    env: executionEnv,
    bwrap,
    privateProc: sandbox.privateProc,
    chdir: cwd
  }), {
    cwd: sandbox.hostWorkspace,
    env: executionEnv,
    stdio
  });
}

export function runProcess({
  binary,
  args,
  cwd,
  env = process.env,
  signal,
  sandbox = null,
  onStdout = null,
  onStderr = null
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess({ binary, args, cwd, env, sandbox, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref?.();
    };

    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    const consume = (channel, chunk) => {
      if (channel === 'stdout') stdout = appendLimited(stdout, chunk);
      else stderr = appendLimited(stderr, chunk);
      try {
        if (channel === 'stdout') onStdout?.(chunk);
        else onStderr?.(chunk);
      } catch (error) {
        child.kill('SIGTERM');
        if (!settled) {
          settled = true;
          signal?.removeEventListener?.('abort', abort);
          reject(error);
        }
      }
    };
    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', abort);
      reject(error);
    });
    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', abort);
      if (signal?.aborted) {
        const error = new Error('Coding-agent execution was interrupted.');
        error.name = 'AbortError';
        reject(error);
        return;
      }
      resolve({ code, signal: closeSignal, stdout, stderr });
    });
  });
}

export function executionError(name, result) {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`${name} execution failed: ${detail}`);
}
