import { requireProvider } from './provider.mjs';

const OUTPUT_LIMIT = 4 * 1024 * 1024;

// Every native process starts through the execution provider carried by the sandbox context. There is no direct
// start: a context without a provider is an error, and process creation exists only inside provider implementations.
export function requireSandbox(sandbox) {
  requireProvider(sandbox);
  return sandbox;
}

// A spawn function injected by a test may replace the provider unless the context's provider is the protocol
// provider, whose guarantee is that nothing but the worker's provider starts a process.
export function selectSpawn(input) {
  if (input.sandbox?.provider?.kind === 'protocol') return spawnProcess;
  return input.spawnImpl || spawnProcess;
}

function appendLimited(current, chunk, limit = OUTPUT_LIMIT) {
  const next = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  if (next.length <= limit) return next.toString('utf8');
  let start = next.length - limit;
  while (start < next.length && (next[start] & 0xc0) === 0x80) start += 1;
  return next.subarray(start).toString('utf8');
}

export function spawnProcess({
  binary, args, cwd, env = process.env, stdio, sandbox = null, processClass = 'run', lifecycle = undefined,
  generatedEnv = undefined
}) {
  const provider = requireProvider(sandbox);
  return provider.start({
    processClass, binary, args, cwd, env, stdio, sandbox,
    ...(lifecycle ? { lifecycle } : {}), ...(generatedEnv ? { generatedEnv } : {})
  });
}

export function runProcess({
  binary,
  args,
  cwd,
  env = process.env,
  signal,
  sandbox = null,
  generatedEnv = undefined,
  onStdout = null,
  onStderr = null
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess({ binary, args, cwd, env, sandbox, generatedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
