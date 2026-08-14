import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 4 * 1024 * 1024;

function appendLimited(current, chunk, limit = OUTPUT_LIMIT) {
  const next = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  if (next.length <= limit) return next.toString('utf8');
  let start = next.length - limit;
  while (start < next.length && (next[start] & 0xc0) === 0x80) start += 1;
  return next.subarray(start).toString('utf8');
}

export function runProcess({ binary, args, cwd, env = process.env, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
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
    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk); });
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
