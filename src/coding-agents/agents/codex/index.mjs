import path from 'node:path';

import { defineAgent } from '../../define-agent.mjs';
import { filled, isRecord, readJson } from '../../login-helpers.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';

export default defineAgent({
  name: 'codex',
  label: 'Codex',
  description: 'Codex',
  binary: { env: 'CODEX_BIN', installPaths: (home) => [path.join(home, '.local', 'bin', 'codex')] },
  capabilities: { approvals: true, privateProc: true },
  state: (env, home) => [{
    source: path.resolve(env.CODEX_HOME || path.join(home, '.codex')),
    target: `${SANDBOX_HOME}/.codex`
  }],
  homeEnvironment: (root) => ({ CODEX_HOME: path.join(root, '.codex') }),
  sandbox: {
    envAllow: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT'],
    envSet: { CODEX_HOME: `${SANDBOX_HOME}/.codex` },
    credentialEnv: ['OPENAI_API_KEY']
  },
  login: {
    files: ['auth.json'],
    // Codex keeps an API key, ChatGPT tokens, or another login mode's fields beside bookkeeping fields.
    async detect(directory) {
      const auth = await readJson(path.join(directory, 'auth.json'));
      return isRecord(auth) && Object.entries(auth)
        .some(([key, value]) => !['last_refresh', 'auth_mode'].includes(key) && filled(value));
    }
  },
  adapter: () => import('./adapter.mjs')
});
