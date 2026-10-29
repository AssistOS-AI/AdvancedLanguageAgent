import { requireSandbox, spawnProcess } from './process.mjs';

const prerequisite = 'Pi RPC requires Pi >=0.85.1 (or a compatible OMP release) with prompt lifecycle support. '
  + 'Upgrade the managed installation or configure PI_BIN/OMP_BIN to a compatible executable.';

export async function requirePiVersion(input) {
  if (input.permissionMode && input.permissionMode !== 'full-access') {
    throw new Error('Pi does not support ask-for-approval; select full-access or use Codex, OpenCode or Claude Code.');
  }
  const spawn = input.spawnImpl || spawnProcess;
  if (spawn === spawnProcess) requireSandbox(input.sandbox);
  if (input.signal?.aborted) throw Object.assign(new Error('Pi version probe interrupted.'), { name: 'AbortError' });
  const version = await new Promise((resolve, reject) => {
    const child = spawn({ ...input, args: ['--version'], cwd: input.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let finished = false;
    let killTimer;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref?.();
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(stdout.trim());
    };
    const abort = () => {
      stop();
      finish(Object.assign(new Error('Pi version probe interrupted.'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => { stop(); finish(new Error(`Pi version probe timed out. ${prerequisite}`)); }, 10000);
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8192) { stop(); finish(new Error(`Invalid Pi version response. ${prerequisite}`)); }
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => finish(new Error(`Pi version probe failed: ${error.message}. ${prerequisite}`)));
    child.on('close', (code) => {
      clearTimeout(killTimer);
      finish(code === 0 ? null : new Error(`Pi version probe exited with ${code}. ${prerequisite}`));
    });
    if (input.signal?.aborted) abort();
  });
  // Accepts bare versions plus pi/pi-coding-agent/omp prefixed forms: "pi v0.85.1",
  // "pi-coding-agent 0.86.0", "omp/18.3.1", "omp v18.3.1", "18.3.1".
  const match = /^(?:(?:pi(?:-coding-agent)?|omp)(?:\/|\s+v?)\s*)?v?(\d+)\.(\d+)\.(\d+)\s*$/u.exec(version);
  const supported = match && (Number(match[1]) > 0 || Number(match[2]) > 85
    || (Number(match[2]) === 85 && Number(match[3]) >= 1));
  if (!supported) throw new Error(`Selected Pi version ${version || '(unknown)'} is incompatible. ${prerequisite}`);
  return version;
}
