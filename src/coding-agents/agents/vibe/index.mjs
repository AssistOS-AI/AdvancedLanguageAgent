import path from 'node:path';

import { defineAgent } from '../../define-agent.mjs';
import { readDotenvValue } from '../../login-helpers.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';

// Mistral Vibe keeps its configuration, sessions and the stored API key under VIBE_HOME (default ~/.vibe).
// Its browser sign-in mints an ordinary Mistral API key. Vibe stores a key in the operating-system keyring when
// one answers and otherwise in VIBE_HOME/.env; the sandbox selects the failing keyring backend, so the key a person
// stores there always lands in that file, where ALA can see it.
export default defineAgent({
  name: 'vibe',
  label: 'Mistral Vibe',
  description: 'Mistral Vibe',
  binary: { env: 'VIBE_BIN', installPaths: (home) => [path.join(home, '.local', 'bin', 'vibe')] },
  // Programmatic mode has no approval channel: a tool call that needs approval is denied, so ALA runs it with
  // --auto-approve inside the sandbox only.
  capabilities: { approvals: false, privateProc: false },
  state: (env, home) => [{
    source: env.VIBE_HOME ? path.resolve(env.VIBE_HOME) : path.join(home, '.vibe'),
    target: `${SANDBOX_HOME}/.vibe`
  }],
  homeEnvironment: (root) => ({ VIBE_HOME: path.join(root, '.vibe') }),
  sandbox: {
    // MISTRAL_API_KEY authenticates the default provider. The two VIBE_ settings are set by the runner for each
    // execution: the MCP servers of the task and the folder that keeps ALA's own sessions.
    envAllow: ['MISTRAL_API_KEY', 'VIBE_MCP_SERVERS', 'VIBE_SESSION_LOGGING__SAVE_DIR'],
    envSet: {
      VIBE_HOME: `${SANDBOX_HOME}/.vibe`,
      // The failing backend of the Python keyring library: every keyring call raises NoKeyringError, so Vibe stores
      // the key in VIBE_HOME/.env. The null backend would accept the key and silently drop it.
      PYTHON_KEYRING_BACKEND: 'keyring.backends.fail.Keyring',
      // The models the account may use, beyond the built-in ones, come from Mistral's per-account catalog, which Vibe
      // fetches only with this setting; `--model` then accepts every catalog model.
      VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG: 'true',
      VIBE_ENABLE_TELEMETRY: 'false',
      VIBE_ENABLE_UPDATE_CHECKS: 'false'
    },
    credentialEnv: ['MISTRAL_API_KEY']
  },
  login: {
    files: ['.env'],
    detect: async (directory) => Boolean(await readDotenvValue(path.join(directory, '.env'), 'MISTRAL_API_KEY'))
  },
  fullAccess: { args: ['--auto-approve', '--trust'], env: {} },
  adapter: () => import('./adapter.mjs'),
  sessions: () => import('./sessions.mjs')
});
