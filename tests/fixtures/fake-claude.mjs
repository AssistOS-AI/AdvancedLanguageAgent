#!/usr/bin/env node
// Imitates the Claude Code stream-json protocol for adapter tests.
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.FAKE_CLAUDE_VERSION || '2.1.287 (Claude Code)'); process.exit(0); }
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(args)}\n`);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const sessionId = value('--session-id') || value('--resume');
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const pendingControl = new Map();
const prompts = [];
let running = false;
let turn = 0;

function control(request) {
  const id = `req-${Math.random()}`;
  out({ type: 'control_request', request_id: id, request });
  return new Promise((resolve) => pendingControl.set(id, resolve));
}

async function runTurn(text) {
  running = true;
  turn += 1;
  if (turn === 1) out({ type: 'system', subtype: 'init', session_id: sessionId, permissionMode: value('--permission-mode') });
  const id = `msg_${turn}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  for (const part of ['Working ', 'on it.']) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  let decision = 'none';
  if (text.includes('TOOL')) {
    const input = { file_path: 'probe.txt', content: 'hello' };
    out({ type: 'assistant', message: { id, content: [{ type: 'tool_use', name: 'Write', input }] } });
    if (args.includes('--permission-prompt-tool')) {
      const response = await control({ subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input });
      decision = response.behavior;
    }
    out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'File created' }] } });
  }
  if (text.includes('FAIL')) out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: sessionId });
  else out({ type: 'result', subtype: 'success', is_error: false, result: `final:${text}:${decision}`, session_id: sessionId });
  running = false;
  if (prompts.length) await runTurn(prompts.shift());
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const record = JSON.parse(line);
  if (record.type === 'control_response') { pendingControl.get(record.response.request_id)?.(record.response.response); return; }
  if (record.type === 'control_request') {
    if (record.request.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: { models: [
        { value: 'opus', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'high', 'max'] },
        { value: 'haiku', displayName: 'Haiku 4.5' }] } } });
    } else out({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: {} } });
    return;
  }
  if (record.type === 'user') {
    const text = record.message.content;
    if (running) prompts.push(text); else void runTurn(text);
  }
}).on('close', () => setTimeout(() => process.exit(0), 10));
