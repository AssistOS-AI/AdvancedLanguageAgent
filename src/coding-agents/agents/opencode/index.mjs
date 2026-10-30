import path from 'node:path';

import { defineAgent } from '../../define-agent.mjs';
import { isRecord, queryLoginDatabase, readJson } from '../../login-helpers.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';
import { PROVIDER_CREDENTIALS, PROVIDER_ENVIRONMENT } from '../provider-environment.mjs';

export default defineAgent({
  name: 'opencode',
  label: 'OpenCode',
  description: 'OpenCode',
  binary: { env: 'OPENCODE_BIN', installPaths: (home) => [path.join(home, '.opencode', 'bin', 'opencode')] },
  capabilities: { approvals: true, privateProc: true },
  state(env, home) {
    const configHome = path.resolve(env.XDG_CONFIG_HOME || path.join(home, '.config'));
    const dataHome = path.resolve(env.XDG_DATA_HOME || path.join(home, '.local', 'share'));
    const cacheHome = path.resolve(env.XDG_CACHE_HOME || path.join(home, '.cache'));
    const stateHome = path.resolve(env.XDG_STATE_HOME || path.join(home, '.local', 'state'));
    return [
      { source: path.join(configHome, 'opencode'), target: `${SANDBOX_HOME}/.config/opencode` },
      { source: path.join(dataHome, 'opencode'), target: `${SANDBOX_HOME}/.local/share/opencode`, login: true },
      { source: path.join(cacheHome, 'opencode'), target: `${SANDBOX_HOME}/.cache/opencode` },
      { source: path.join(stateHome, 'opencode'), target: `${SANDBOX_HOME}/.local/state/opencode` }
    ];
  },
  sandbox: {
    envAllow: [...PROVIDER_ENVIRONMENT, 'OPENCODE_ENABLE_EXA', 'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD'],
    envSet: {},
    credentialEnv: PROVIDER_CREDENTIALS,
    installMarker: '.opencode'
  },
  login: {
    files: ['auth.json', 'opencode.db', 'opencode.db-wal'],
    // OpenCode keeps provider keys and OAuth logins in auth.json, and Console accounts and connector
    // credentials in its database.
    async detect(directory) {
      const auth = await readJson(path.join(directory, 'auth.json'));
      const stored = isRecord(auth)
        && Object.values(auth).some((entry) => isRecord(entry) && typeof entry.type === 'string');
      if (stored) return true;
      return queryLoginDatabase(path.join(directory, 'opencode.db'), (database, tables) => {
        const any = (table, where) => tables.has(table)
          && Boolean(database.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get());
        return any('account_state', 'active_account_id IS NOT NULL OR active_org_id IS NOT NULL')
          || any('control_account', 'active = 1') || any('credential', '1 = 1');
      });
    }
  },
  adapter: () => import('./adapter.mjs')
});
