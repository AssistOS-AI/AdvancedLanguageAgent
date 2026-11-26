import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getAgent } from './registry.mjs';

export const SYSTEM_PROMPT_LIMIT = 16 * 1024;

export function validateSystemPrompt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > SYSTEM_PROMPT_LIMIT) {
    throw new TypeError('systemPrompt must be text without NUL, at most 16384 UTF-8 bytes.');
  }
  return value;
}

// Generated configuration is private to this launch and mounted only in its sandbox. It never changes
// the caller's project or shared agent home. Adapters describe native instruction channels, not user turns.
export function prepareNativeInstructions(agent, value, env = {}) {
  const text = validateSystemPrompt(value);
  const empty = { args: [], env: {}, fileMounts: [], cleanup() {} };
  if (text === null) return empty;
  const configure = getAgent(agent)?.nativeInstructions;
  if (!configure) throw new TypeError(`Native systemPrompt is not supported by coding agent: ${agent}`);
  const name = `ala-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
  const config = configure({ text, name, env, promptPath: `/tmp/${name}.md` });
  if (!config.files?.length) return { ...empty, ...config };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ala-instructions-'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const fileMounts = config.files.map(({ target, content }, index) => {
      const source = path.join(directory, String(index));
      fs.writeFileSync(source, content, { mode: 0o600, flag: 'wx' });
      return { source, target };
    });
    return { ...empty, ...config, fileMounts, cleanup };
  } catch (error) { cleanup(); throw error; }
}
