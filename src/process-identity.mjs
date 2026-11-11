import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

// macOS has no /proc. ps prints the start time in local time, so it runs with a fixed environment:
// a time-zone or DST change must never make a live lock holder look like another process.
export const PS_ENVIRONMENT = Object.freeze({ TZ: 'UTC', LC_ALL: 'C' });
// The macOS kernel never assigns a PID above PID_MAX (99999, bsd/sys/proc_internal.h), and ps refuses such a
// PID with "process id too large" and exit 1, so no process can have one.
export const DARWIN_PID_MAX = 99_999;

function noSuchProcess(pid) {
  return Object.assign(new Error(`No such process: ${pid}`), { code: 'ENOENT' });
}

// Classifies one ps run. The session lock treats ENOENT as a dead holder and removes its lock, so only the one
// outcome ps gives for a free PID counts: exit 1 with nothing on either stream. Its own errors (an invalid PID,
// a usage error) also exit 1 but print a message; those, a spawn failure, a signal, a timeout and an empty
// successful run are failures without a code, and the lock is kept.
export function interpretPs(pid, { error = null, stdout = '', stderr = '' } = {}) {
  const output = String(stdout ?? '').trim();
  if (!error) {
    return output ? { start: output }
      : { error: new Error(`Cannot read the start time of process ${pid}: ps printed nothing.`) };
  }
  const silent = !output && !String(stderr ?? '').trim();
  if (error.code === 1 && !error.signal && silent) return { error: noSuchProcess(pid) };
  return { error: new Error(`Cannot read the start time of process ${pid}: ${error.message || error}`) };
}

function darwinIdentity(pid, run) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error(`Invalid process id: ${pid}`));
  if (pid > DARWIN_PID_MAX) return Promise.reject(noSuchProcess(pid));
  return new Promise((resolve, reject) => {
    const settle = (result) => (result.error ? reject(result.error) : resolve(result.start));
    try {
      run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: PS_ENVIRONMENT, timeout: 10_000 },
        (error, stdout, stderr) => settle(interpretPs(pid, { error, stdout, stderr })));
    } catch (error) {
      // A spawn failure can also be thrown synchronously; it must never reach the caller with its own code.
      settle(interpretPs(pid, { error }));
    }
  });
}

// Resolve a string that identifies one process start, so a reused PID is never taken for its
// predecessor. Rejects with code ENOENT when no process has that PID. Tests may replace execFile.
export async function processIdentity(pid, { execFileImpl = execFile, platform = process.platform } = {}) {
  if (platform === 'darwin') return darwinIdentity(pid, execFileImpl);
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
