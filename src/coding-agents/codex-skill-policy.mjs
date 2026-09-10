import { openJsonChannel } from './json-channel.mjs';
import { posix } from 'node:path';

function selectedPaths(input) {
  return new Set((input.sandbox.mounts || []).filter((mount) => mount.purpose === 'task-skill')
    .map((mount) => `${mount.target}/SKILL.md`));
}

async function readNativeCatalog(input, rpc) {
  const result = await rpc.request({ method: 'skills/list', params: { cwds: [input.workspace], forceReload: true } });
  input.signal?.throwIfAborted();
  const matches = Array.isArray(result.data) ? result.data.filter((record) => record?.cwd === input.workspace) : [];
  const entry = matches.length === 1 ? matches[0] : null;
  if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) {
    throw new Error('Codex returned an invalid native skill inventory.');
  }
  if (entry.errors.length) throw new Error('Codex native skill inventory contains errors; selected-only registration cannot be established.');
  const paths = new Set();
  for (const skill of entry.skills) {
    const file = skill?.path;
    if (typeof file !== 'string' || !posix.isAbsolute(file) || posix.normalize(file) !== file || file.includes('\0')
      || typeof skill.enabled !== 'boolean' || paths.has(file)) {
      throw new Error('Codex returned an invalid native skill inventory entry.');
    }
    paths.add(file);
  }
  return entry;
}

function matchesSelection(current, selected) {
  return [...selected].every((file) => current.skills.some((skill) => skill.path === file && skill.enabled))
    && current.skills.every((skill) => !skill.enabled || selected.has(skill.path));
}

// Preflight configuration is enumerated by path. A later native process may discover
// new paths, so validate its actual registration before allowing a model turn.
export async function verifyCodexSkillPolicy(input, rpc, phase = 'before model turn') {
  if (!input.sandbox?.isolatedSkills) return;
  const selected = selectedPaths(input);
  let current;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    current = await readNativeCatalog(input, rpc);
    if (matchesSelection(current, selected)) return;
  }
  const enabled = new Set(current.skills.filter((skill) => skill.enabled).map((skill) => skill.path));
  const missing = [...selected].filter((file) => !enabled.has(file)).slice(0, 8);
  const unexpected = [...enabled].filter((file) => !selected.has(file)).slice(0, 8);
  throw Object.assign(new Error(`Codex execution skill registration differs from the selected catalog ${phase}; retry the execution. Missing: ${JSON.stringify(missing)}. Unexpected: ${JSON.stringify(unexpected)}. Native errors: ${JSON.stringify(current.errors.slice(0, 8))}.`), {
    code: 'CODEX_SKILL_REGISTRATION_CHANGED',
    skillPaths: current.skills.map((skill) => skill.path).filter((file) => typeof file === 'string' && file.startsWith('/'))
  });
}

async function nativeCatalog(input, overrides, openChannel) {
  input.signal?.throwIfAborted();
  const rpc = openChannel(input, [...overrides, 'app-server']);
  const abort = () => { void rpc.close(); };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    await rpc.request({ method: 'initialize', params: { clientInfo: { name: 'ala', version: '1' } } });
    rpc.send({ method: 'initialized', params: {} });
    return await readNativeCatalog(input, rpc);
  } finally { input.signal?.removeEventListener('abort', abort); await rpc.close(); }
}

export async function codexSkillPolicyOverrides(input, openChannel = openJsonChannel) {
  if (!input.sandbox?.isolatedSkills) return [];
  const selected = selectedPaths(input);
  let current;
  try { current = await nativeCatalog(input, [], openChannel); }
  catch (error) { throw new Error(`Codex cannot enforce the selected skill catalog: ${error.message}`); }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const file of selected) {
      if (!current.skills.some((skill) => skill.path === file)) {
        throw new Error(`Selected task skill is absent from Codex native registration: ${file}`);
      }
    }
    const entries = new Map();
    for (const file of input.nativeSkillPaths || []) entries.set(file, selected.has(file));
    for (const skill of current.skills) {
      if (typeof skill.path !== 'string' || !skill.path.startsWith('/')) {
        throw new Error('Codex returned an invalid native skill path.');
      }
      entries.set(skill.path, selected.has(skill.path));
    }
    const value = `[${[...entries].map(([file, enabled]) => `{path=${JSON.stringify(file)},enabled=${enabled}}`).join(',')}]`;
    const overrides = ['--config', `skills.config=${value}`];
    current = await nativeCatalog(input, overrides, openChannel);
    if (matchesSelection(current, selected)) return overrides;
  }
  throw new Error('Codex native skill registration changed while applying the selected catalog.');
}
