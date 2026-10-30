import path from 'node:path';

import { defineAgent } from '../../define-agent.mjs';
import { filled, isRecord, readJson } from '../../login-helpers.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';
import { PROVIDER_CREDENTIALS, PROVIDER_ENVIRONMENT } from '../provider-environment.mjs';

export default defineAgent({
  name: 'pi',
  label: 'Pi',
  description: 'Pi',
  binary: { env: 'PI_BIN', installPaths: (home) => [path.join(home, '.local', 'bin', 'pi')] },
  capabilities: { approvals: false, privateProc: false },
  state: (env, home) => [{
    source: env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(home, '.pi', 'agent'),
    target: `${SANDBOX_HOME}/.pi/agent`
  }],
  homeEnvironment: (root) => ({ PI_CODING_AGENT_DIR: path.join(root, '.pi', 'agent') }),
  sandbox: {
    envAllow: PROVIDER_ENVIRONMENT,
    envSet: { PI_CODING_AGENT_DIR: `${SANDBOX_HOME}/.pi/agent`, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
    credentialEnv: PROVIDER_CREDENTIALS
  },
  login: {
    files: ['auth.json'],
    // Pi stores { type: 'api_key', key | env } or { type: 'oauth', access, refresh } per provider.
    async detect(directory) {
      const auth = await readJson(path.join(directory, 'auth.json'));
      return isRecord(auth) && Object.values(auth).some((entry) => isRecord(entry)
        && ((entry.type === 'api_key' && (filled(entry.key) || filled(entry.env)))
          || (entry.type === 'oauth' && filled(entry.access))));
    }
  },
  adapter: () => import('./adapter.mjs')
});
