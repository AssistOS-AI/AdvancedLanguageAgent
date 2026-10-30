import path from 'node:path';

import { defineAgent } from '../../define-agent.mjs';
import { queryLoginDatabase } from '../../login-helpers.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';
import { PROVIDER_CREDENTIALS, PROVIDER_ENVIRONMENT } from '../provider-environment.mjs';

export default defineAgent({
  name: 'omp',
  label: 'OMP',
  description: 'OMP (Oh My Pi)',
  binary: { env: 'OMP_BIN', installPaths: (home) => [path.join(home, '.local', 'bin', 'omp')] },
  capabilities: { approvals: false, privateProc: false },
  // OMP keeps auth, sessions, and the auth-broker vault under ~/.omp.
  state: (env, home) => [{
    source: env.OMP_DIR ? path.resolve(env.OMP_DIR) : path.join(home, '.omp'),
    target: `${SANDBOX_HOME}/.omp`
  }],
  homeEnvironment: (root) => ({ OMP_DIR: path.join(root, '.omp') }),
  sandbox: { envAllow: PROVIDER_ENVIRONMENT, envSet: {}, credentialEnv: PROVIDER_CREDENTIALS },
  login: {
    files: ['agent/agent.db', 'agent/agent.db-wal'],
    // OMP keeps its logins as rows of agent/agent.db; a row that was disabled (for example after a revoked
    // refresh token) is not a login.
    detect: (directory) => queryLoginDatabase(path.join(directory, 'agent', 'agent.db'), (database, tables) => (
      tables.has('auth_credentials')
        && Boolean(database.prepare('SELECT 1 FROM auth_credentials WHERE disabled_cause IS NULL LIMIT 1').get())
    ))
  },
  adapter: () => import('./adapter.mjs')
});
