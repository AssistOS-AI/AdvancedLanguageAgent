import { fullAccessPolicy } from '../../native-interactive.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ALAError, EXIT_CODES } from '../../../errors.mjs';
import { detectCodingAgentLogin, homeEnvironment } from '../../logins.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';
import { requireSandbox, runProcess } from '../../process.mjs';
import { createLineDecoder } from '../../streaming.mjs';

// The Antigravity CLI runs one turn per process. The prompt is the single `user` record of `--input-format
// stream-json` on stdin, so its size is not bound by the argument limit, and `--output-format stream-json` prints
// one NDJSON event per line: `init`, `step_update` (user input, agent response text deltas, tool steps) and a final
// `result` with `status`, `response` and `error`. Every step carries the `conversation_id`, which a later turn
// resumes with `--conversation <id>`.
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TOOL_SUMMARY_LIMIT = 300;

export function buildAgyArguments({ resume = null, model = null, effort = null } = {}) {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', ...fullAccessPolicy('agy').args];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--conversation', resume);
  return args;
}

export const agyPromptRecord = (prompt) => `${JSON.stringify({ event: 'user', message: { content: String(prompt ?? '') } })}\n`;

// The MCP servers of a task as agy's mcp_config.json. agy reads it from ~/.gemini/config, where this file is bound
// for one execution only, so the robot's own configuration is never changed and concurrent runs do not collide.
export function agyMcpConfig(mcpServers) {
  return { mcpServers: Object.fromEntries(mcpServers.map(({ name, url }) => [name, { serverUrl: url }])) };
}

function toolSummary(step) {
  const info = step.tool_info || {};
  const parameters = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
  const detail = [parameters.CommandLine, parameters.TargetFile, parameters.AbsolutePath, parameters.Url, parameters.Query]
    .find((value) => typeof value === 'string' && value.trim());
  const name = step.tool_name || info.name || 'tool';
  const line = detail ? `${name}: ${detail.trim()}` : name;
  const error = info.error?.message ? ` (failed: ${info.error.message})` : '';
  return `${line.length > TOOL_SUMMARY_LIMIT ? `${line.slice(0, TOOL_SUMMARY_LIMIT - 1)}…` : line}${error}\n`;
}

export function createAgyStreamParser({ onText = () => {}, onSession = () => {} } = {}) {
  const emit = typeof onText === 'function' ? onText : () => {};
  let conversationId = null;
  let result = null;
  const lines = createLineDecoder((line) => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch {
      emit(`${line}\n`);
      return;
    }
    const payload = record?.[record?.event];
    if (!payload || typeof payload !== 'object') return;
    if (!conversationId && typeof payload.conversation_id === 'string' && CONVERSATION_ID.test(payload.conversation_id)) {
      conversationId = payload.conversation_id;
      onSession(conversationId);
    }
    if (record.event === 'result') {
      result = payload;
      return;
    }
    if (record.event !== 'step_update') return;
    if (payload.step_type === 'agent_response') {
      const metadata = { outputKind: 'assistant', outputId: `agy-${payload.step_index}` };
      const text = typeof payload.text_delta === 'string' ? payload.text_delta : '';
      if (payload.state === 'DONE') emit(text, { ...metadata, outputComplete: true });
      else if (text) emit(text, metadata);
    } else if (payload.step_type === 'tool' && payload.state === 'DONE') {
      emit(toolSummary(payload));
    }
  });
  return {
    push: lines.push,
    finish: lines.finish,
    result: () => result,
    conversationId: () => conversationId
  };
}

function resumeValue(continuation) {
  const value = continuation?.conversationId;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !CONVERSATION_ID.test(value)) throw new Error('Invalid Antigravity CLI conversation identifier.');
  return value;
}

// Without a stored login agy waits for an authorization code on stdin instead of failing, so a run is refused first.
export async function requireAgyLogin({ env, sandbox }) {
  const loginEnv = sandbox?.home ? homeEnvironment(env, sandbox.home) : env;
  if ((await detectCodingAgentLogin('agy', { env: loginEnv })).loggedIn) return;
  throw new ALAError('Antigravity CLI is not logged in. Run `agy` once in this home and sign in with Google.', EXIT_CODES.execution);
}

export function agyFailure(result, processResult) {
  const detail = (typeof result?.error === 'string' && result.error.trim())
    || String(processResult?.stderr || '').trim().split('\n').slice(-5).join(' ')
    || (result?.status ? `status ${result.status}` : `exit code ${processResult?.code}`);
  return new Error(`Antigravity CLI execution failed: ${detail}`);
}

// A file for one execution, mounted at agy's MCP configuration path inside the sandbox.
async function mcpMount(mcpServers, sandbox) {
  if (!mcpServers.length) return null;
  const directory = await mkdtemp(path.join(tmpdir(), 'ala-agy-mcp-'));
  const source = path.join(directory, 'mcp_config.json');
  await writeFile(source, `${JSON.stringify(agyMcpConfig(mcpServers))}\n`, { mode: 0o600 });
  // Bubblewrap creates a missing mount point inside the bound home; its folder must exist there.
  if (sandbox.home) await mkdir(path.join(sandbox.home, '.gemini', 'config'), { recursive: true, mode: 0o700 });
  return { directory, mount: { source, target: `${SANDBOX_HOME}/.gemini/config/mcp_config.json` } };
}

export async function runAgy(input) {
  const { binary, prompt, workspace, model, effort, env, signal, sandbox, onVisibleText,
    continuation = null, mcpServers = [], onSession = null } = input;
  requireSandbox(sandbox);
  const resume = resumeValue(continuation);
  await requireAgyLogin({ env, sandbox });
  let reported = resume;
  const parser = createAgyStreamParser({
    onText: onVisibleText,
    onSession: (conversationId) => {
      if (conversationId === reported) return;
      reported = conversationId;
      // The conversation is recorded as soon as agy names it, so a turn that fails can still be resumed.
      Promise.resolve(onSession?.({ conversationId })).catch(() => {});
    }
  });
  const mcp = await mcpMount(mcpServers, sandbox);
  let processResult;
  try {
    processResult = await runProcess({
      binary, args: buildAgyArguments({ resume, model, effort }), cwd: workspace, env, signal,
      sandbox: mcp ? { ...sandbox, fileMounts: [...(sandbox.fileMounts || []), mcp.mount] } : sandbox,
      input: agyPromptRecord(prompt),
      onStdout: parser.push
    });
  } finally {
    if (mcp) await rm(mcp.directory, { recursive: true, force: true });
  }
  parser.finish();
  const conversationId = parser.conversationId() || resume;
  const nextContinuation = conversationId ? { conversationId } : continuation;
  const attach = (error) => Object.assign(error, nextContinuation ? { continuation: nextContinuation } : {});
  const result = parser.result();
  if (processResult.code !== 0 || result?.status !== 'SUCCESS') throw attach(agyFailure(result, processResult));
  const outputText = String(result.response || '').trim();
  if (!outputText) throw attach(new Error('Antigravity CLI completed without a final assistant message.'));
  return { outputText, ...(nextContinuation ? { continuation: nextContinuation } : {}) };
}

// `agy models` prints `<model id>\t<label>` per model the signed-in account may use. Gemini models carry their
// reasoning effort in the identifier and reject --effort, so no model advertises efforts.
export function parseAgyModels(stdout) {
  return String(stdout).split('\n').map((line) => line.split('\t'))
    .filter(([id, label]) => label !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id.trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() || id.trim(), efforts: [] }));
}

export async function listAgyModels({ binary, cwd, env, signal, sandbox }) {
  requireSandbox(sandbox);
  await requireAgyLogin({ env, sandbox });
  const result = await runProcess({ binary, args: ['models'], cwd, env, signal, sandbox, input: '' });
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').at(-1) || `exit code ${result.code}`;
    throw new Error(`Antigravity CLI model listing failed: ${detail}`);
  }
  const models = parseAgyModels(result.stdout);
  if (!models.length) throw new Error('Antigravity CLI returned no models.');
  return models;
}

