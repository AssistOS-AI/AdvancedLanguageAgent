import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { normalizeResult } from './output.mjs';

export const ALA_EVENT_PREFIX = '@@ALA_EVENT@@';

function timestampForFilename(date) {
  return date.toISOString().replaceAll(':', '-');
}

export function createSessionRecorder({ configPath, mode = 'one-shot', now = () => new Date() }) {
  const sessionsDirectory = resolve(dirname(configPath), 'sessions');
  let filePath = null;
  let sequence = 0;
  let turn = 0;
  let queue = Promise.resolve();
  let writeError = null;
  let closed = false;

  function enqueue(event) {
    if (!filePath || closed) return;
    const record = {
      sequence: ++sequence,
      timestamp: now().toISOString(),
      ...event
    };
    queue = queue
      .then(() => appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8'))
      .catch((error) => { writeError ||= error; });
  }

  async function ensureStarted() {
    if (filePath) return;
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionsDirectory, 0o700);
    const startedAt = now();
    filePath = join(sessionsDirectory, `${timestampForFilename(startedAt)}_${randomUUID()}.jsonl`);
    await writeFile(filePath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    enqueue({ type: 'session-started', mode });
  }

  return {
    get filePath() { return filePath; },
    get sessionsDirectory() { return sessionsDirectory; },
    async recordPrompt(content) {
      if (closed) throw new Error('Cannot record a prompt after the session recorder has closed.');
      await ensureStarted();
      turn += 1;
      enqueue({ type: 'prompt', turn, content: String(content ?? '') });
      await queue;
    },
    record(event) {
      if (!filePath || !event || typeof event !== 'object') return;
      enqueue({ ...event, turn });
    },
    async close(status = 'completed') {
      if (!filePath || closed) return;
      enqueue({ type: 'session-ended', status });
      closed = true;
      await queue;
      if (writeError) throw writeError;
    }
  };
}

export function createRuntimeEventSink({ recorder, stream = process.stderr, env = process.env }) {
  const streamEnabled = env.ALA_EVENT_STREAM === '1' || env.ALA_EVENT_STREAM === 'true';
  return (event) => {
    recorder.record(event);
    if (streamEnabled) stream.write(`${ALA_EVENT_PREFIX}${JSON.stringify(event)}\n`);
  };
}

export async function recordExecution(recorder, prompt, execute) {
  await recorder.recordPrompt(prompt);
  try {
    const result = await execute();
    recorder.record({ type: 'final', message: normalizeResult(result) });
    return result;
  } catch (error) {
    recorder.record({ type: 'error', message: error?.message || String(error) });
    throw error;
  }
}
