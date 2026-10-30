import path from 'node:path';

import { defineAgent } from '../../define-agent.mjs';
import { filled, isRecord, readJson } from '../../login-helpers.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';

export default defineAgent({
  name: 'claude',
  label: 'Claude Code',
  description: 'Claude Code',
  binary: { env: 'CLAUDE_BIN', installPaths: (home) => [path.join(home, '.local', 'bin', 'claude')] },
  capabilities: { approvals: true, privateProc: false },
  state: (env, home) => [{
    source: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
    target: `${SANDBOX_HOME}/.claude`
  }],
  homeEnvironment: (root) => ({ CLAUDE_CONFIG_DIR: path.join(root, '.claude') }),
  sandbox: {
    // Claude Code uses only Anthropic credentials, from its login or these variables.
    envAllow: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
    envSet: {
      // All Claude Code state, including .claude.json and the login, lives here.
      CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude`,
      // The sandbox may run as uid 0; Claude Code refuses bypassPermissions as
      // root unless it is told it runs inside a sandbox.
      IS_SANDBOX: '1',
      DISABLE_AUTOUPDATER: '1'
    },
    credentialEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
  },
  login: {
    files: ['.credentials.json', '.claude.json'],
    // Claude Code keeps a subscription login in .credentials.json and an API key in .claude.json, both under
    // CLAUDE_CONFIG_DIR, which the sandbox always sets.
    async detect(directory) {
      const credentials = await readJson(path.join(directory, '.credentials.json'));
      const oauth = credentials?.claudeAiOauth;
      if (isRecord(oauth) && (filled(oauth.accessToken) || filled(oauth.refreshToken))) return true;
      const config = await readJson(path.join(directory, '.claude.json'));
      return isRecord(config) && filled(config.primaryApiKey);
    }
  },
  adapter: () => import('./adapter.mjs')
});
