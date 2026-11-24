import { fullAccessPolicy } from '../../native-interactive.mjs';
import { mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { requireSandbox, runProcess } from '../../process.mjs';
import { appendBoundedTail, contentText, createLineDecoder } from '../../streaming.mjs';

// Mistral Vibe runs one turn per process in programmatic mode (`-p`). The prompt is read from stdin, so its size is
// not bound by the argument limit. `--output streaming` prints one JSON history entry per line as each entry
// completes: user and assistant `message` entries and tool `effect` entries, every one carrying the `sessionId`.
// A later turn resumes that session with `--resume <id>`; Vibe keeps the session's model and thinking level, so
// `--model` and `--thinking` apply to a new session only.
const MINIMUM_VERSION = [3, 0, 0];
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MODELS_MARKER = '@@ALA_VIBE_MODELS@@';
const prerequisite = `Mistral Vibe >=${MINIMUM_VERSION.join('.')} is required. `
  + 'Install it with `uv tool install mistral-vibe` or configure VIBE_BIN to a compatible executable.';

export async function requireVibeVersion({ binary, workspace, env, signal, sandbox }) {
  const result = await runProcess({ binary, args: ['--version'], cwd: workspace, env, signal, sandbox });
  const version = result.stdout.trim();
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  const parts = match ? match.slice(1, 4).map(Number) : null;
  const supported = parts && (parts[0] - MINIMUM_VERSION[0] || parts[1] - MINIMUM_VERSION[1]
    || parts[2] - MINIMUM_VERSION[2]) >= 0;
  if (result.code !== 0 || !supported) {
    throw new Error(`Selected Mistral Vibe version ${version || '(unknown)'} is incompatible. ${prerequisite}`);
  }
  return version;
}

export function buildVibeArguments({ resume = null, model = null, effort = null } = {}) {
  // --trust accepts the working folder for this run, which ALA has already granted.
  const args = ['-p', '--output', 'streaming', ...fullAccessPolicy('vibe').args];
  if (resume) args.push('--resume', resume);
  else {
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
  }
  return args;
}

// The per-execution settings travel as Vibe's own VIBE_<FIELD> configuration variables. A value inherited from the
// caller is never used: the MCP servers are exactly the task's, and ALA's sessions stay in the workspace's own
// folder so the interactive catalog under VIBE_HOME never lists them.
export function vibeEnvironment(env, { sessionDir, mcpServers = [] }) {
  const values = { ...env, VIBE_SESSION_LOGGING__SAVE_DIR: sessionDir };
  delete values.VIBE_MCP_SERVERS;
  if (mcpServers.length) {
    values.VIBE_MCP_SERVERS = JSON.stringify(mcpServers.map(({ name, url }) => ({ name, transport: 'streamable-http', url })));
  }
  return values;
}

function effectText(entry) {
  const display = entry.detail?.display;
  const summary = [display?.summary, display?.message, entry.title]
    .find((value) => typeof value === 'string' && value.trim())?.trim();
  const output = typeof entry.state?.outputText === 'string' ? entry.state.outputText.trim() : '';
  return [summary, output].filter(Boolean).map((text) => `${text}\n`).join('');
}

export function createVibeStreamParser({ onText = () => {}, onSession = () => {} } = {}) {
  const emit = typeof onText === 'function' ? onText : () => {};
  let sessionId = null;
  let finalText = '';
  const lines = createLineDecoder((line) => {
    if (!line.trim()) return;
    let entry;
    try { entry = JSON.parse(line); } catch {
      emit(`${line}\n`);
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    if (!sessionId && typeof entry.sessionId === 'string' && SESSION_ID.test(entry.sessionId)) {
      sessionId = entry.sessionId;
      onSession(sessionId);
    }
    if (entry.type === 'effect') {
      const text = effectText(entry);
      if (text) emit(text);
      return;
    }
    if (entry.type !== 'message' || entry.role !== 'assistant') return;
    const text = contentText(entry.content).trim();
    if (!text) return;
    emit(text, { outputKind: 'assistant', outputComplete: true, ...(typeof entry.id === 'string' ? { outputId: entry.id } : {}) });
    finalText = appendBoundedTail('', text);
  });
  return {
    push: lines.push,
    finish: lines.finish,
    finalText: () => finalText.trim(),
    sessionId: () => sessionId
  };
}

// Vibe reports a failed run on stderr as `Error: <message>`; its keyring notice is not part of the failure.
export function vibeFailure(result) {
  const lines = String(result.stderr || '').split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Reading API keys from the system keyring'));
  const error = lines.filter((line) => line.startsWith('Error:')).map((line) => line.slice('Error:'.length).trim()).at(-1);
  const detail = error || lines.slice(-5).join(' ') || String(result.stdout || '').trim().slice(-2000) || `exit code ${result.code}`;
  return new Error(`Mistral Vibe execution failed: ${detail}`);
}

function resumeValue(continuation) {
  const value = continuation?.sessionId;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid Mistral Vibe session identifier.');
  return value;
}

export async function runVibe(input) {
  const { binary, prompt, workspace, hostWorkspace, model, effort, env, signal, sandbox, onVisibleText,
    continuation = null, mcpServers = [], onSession = null } = input;
  requireSandbox(sandbox);
  await requireVibeVersion({ binary, workspace, env, signal, sandbox });
  const resume = resumeValue(continuation);
  const sessionDir = path.join(workspace, '.ala-vibe-sessions');
  await mkdir(path.join(hostWorkspace, '.ala-vibe-sessions'), { recursive: true, mode: 0o700 });
  let reported = resume;
  const parser = createVibeStreamParser({
    onText: onVisibleText,
    onSession: (sessionId) => {
      if (sessionId === reported) return;
      reported = sessionId;
      // The native session is recorded as soon as Vibe names it, so a turn that fails can still be resumed.
      Promise.resolve(onSession?.({ sessionId })).catch(() => {});
    }
  });
  const result = await runProcess({
    binary, args: buildVibeArguments({ resume, model, effort }), cwd: workspace, signal, sandbox,
    env: vibeEnvironment(env, { sessionDir, mcpServers }),
    input: String(prompt ?? ''),
    onStdout: parser.push
  });
  parser.finish();
  const sessionId = parser.sessionId() || resume;
  const nextContinuation = sessionId ? { sessionId } : continuation;
  if (result.code !== 0) throw Object.assign(vibeFailure(result), nextContinuation ? { continuation: nextContinuation } : {});
  const outputText = parser.finalText();
  if (!outputText) {
    throw Object.assign(new Error('Mistral Vibe completed without a final assistant message.'),
      nextContinuation ? { continuation: nextContinuation } : {});
  }
  return { outputText, ...(nextContinuation ? { continuation: nextContinuation } : {}) };
}

// The model list is Vibe's effective configuration: the built-in Mistral models, every [[models]] entry of the user's
// and the project's config.toml, and, with the catalog enabled and a Mistral key in the environment or VIBE_HOME/.env,
// the account's model catalog that Vibe itself fetches at the start of a session, each with the thinking levels it
// accepts. Vibe has no command that prints it, so the interpreter of Vibe's own Python environment loads the
// configuration the way Vibe does, applies the catalog with Vibe's own function, and prints it. A catalog that cannot
// be fetched leaves the local configuration, as it does in Vibe.
export const VIBE_MODELS_SCRIPT = `
import asyncio, json, os, urllib.request
from vibe.core.config.harness_files._harness_manager import init_harness_files_manager
from vibe.core.config.default_orchestrator import build_default_orchestrator
init_harness_files_manager("user", "project")

async def main():
    orchestrator = await build_default_orchestrator()
    config = orchestrator.config
    source = "local"
    if config.experimental_enable_model_catalog:
        try:
            from vibe.core.config.layers.model_catalog import apply_model_catalog
            from vibe.core.config.vibe_schema import load_dotenv_values
            from vibe.core.model_catalog.models import parse_model_catalog_response
            load_dotenv_values()
            provider = next(p for p in config.providers if p.name == "mistral")
            key = os.environ.get(provider.api_key_env_var or "MISTRAL_API_KEY", "")
            if key:
                url = provider.api_base.rstrip("/") + "/model-catalog?surface=vibe-code"
                request = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "Accept": "application/json"})
                with urllib.request.urlopen(request, timeout=10) as response:
                    catalog = parse_model_catalog_response(json.loads(response.read(8 * 1024 * 1024)))
                if catalog is not None:
                    await apply_model_catalog(orchestrator, catalog)
                    config = orchestrator.config
                    source = "account"
        except Exception as error:
            source = "local: " + type(error).__name__
    print(${JSON.stringify(MODELS_MARKER)} + json.dumps({"source": source, "models": [
        {"alias": m.alias, "name": m.name, "label": getattr(m, "display_name", None) or m.alias,
         "thinking": getattr(m, "thinking", None), "levels": list(getattr(m, "thinking_levels", None) or [])}
        for m in config.available_models().values()]}))

asyncio.run(main())
`;

export function parseVibeModels(stdout) {
  const line = String(stdout).split('\n').find((value) => value.startsWith(MODELS_MARKER));
  let listing;
  try { listing = JSON.parse(line.slice(MODELS_MARKER.length)); } catch { throw new Error('Mistral Vibe returned an invalid model list.'); }
  const models = Array.isArray(listing) ? listing : listing?.models;
  if (!Array.isArray(models)) throw new Error('Mistral Vibe returned an invalid model list.');
  return models.filter((model) => typeof model?.alias === 'string' && model.alias).map((model) => {
    const efforts = (Array.isArray(model.levels) ? model.levels : [])
      .filter((level) => typeof level === 'string' && /^[A-Za-z0-9_-]+$/u.test(level));
    return {
      id: model.alias,
      label: typeof model.label === 'string' && model.label ? model.label : model.alias,
      efforts,
      ...(efforts.includes(model.thinking) ? { defaultEffort: model.thinking } : {})
    };
  });
}

// `<venv>/bin/vibe` and `<venv>/bin/python` of the environment Vibe is installed in. The interpreter is started by
// its path inside the environment, through /bin/sh, so Python finds the environment's packages.
export async function vibePythonEnvironment(binary) {
  const launcher = await realpath(binary);
  const python = path.join(path.dirname(launcher), 'python');
  if (!existsSync(path.join(path.dirname(path.dirname(launcher)), 'pyvenv.cfg')) || !existsSync(python)) {
    throw new Error('Mistral Vibe model listing needs Vibe installed in its own Python environment (uv tool install mistral-vibe).');
  }
  return { launcher, python };
}

export async function listVibeModels({ binary, cwd, env, signal, sandbox }) {
  requireSandbox(sandbox);
  const { launcher, python } = await vibePythonEnvironment(binary);
  const result = await runProcess({
    binary: '/bin/sh', args: ['-c', 'exec "$0" -I -c "$1"', python, VIBE_MODELS_SCRIPT], cwd, env, signal,
    sandbox: { ...sandbox, runtimeBinaries: [...(sandbox.runtimeBinaries || []), launcher] }
  });
  if (result.code !== 0) {
    const detail = String(result.stderr || '').trim().split('\n').at(-1) || `exit code ${result.code}`;
    throw new Error(`Mistral Vibe model listing failed: ${detail}`);
  }
  return parseVibeModels(result.stdout);
}
