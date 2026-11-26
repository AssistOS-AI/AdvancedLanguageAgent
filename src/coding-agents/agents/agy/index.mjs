import path from 'node:path';

import { defineAgent } from '../../define-agent.mjs';
import { filled, isRecord, readJson } from '../../login-helpers.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';

// Google's Antigravity CLI (`agy`) keeps all its state under ~/.gemini: `antigravity-cli/` holds the login token,
// the conversations and their summary catalog, and `config/` holds its MCP servers and projects. Gemini CLI also
// uses ~/.gemini, so only these two folders are mounted. With SSH_TTY set, agy stores its Google login in
// antigravity-cli/antigravity-oauth-token instead of an operating-system keyring, the way it does over SSH.
// Relative to the login directory, ~/.gemini/antigravity-cli.
export const AGY_TOKEN_FILE = 'antigravity-oauth-token';

export default defineAgent({
  name: 'agy',
  label: 'Antigravity CLI',
  description: 'Antigravity CLI (agy)',
  binary: { env: 'AGY_BIN', installPaths: (home) => [path.join(home, '.local', 'bin', 'agy')] },
  // Print mode has no approval channel; ALA runs it with --dangerously-skip-permissions inside the sandbox only.
  capabilities: { approvals: false, privateProc: false },
  state: (env, home) => [
    { source: path.join(home, '.gemini', 'antigravity-cli'), target: `${SANDBOX_HOME}/.gemini/antigravity-cli`, login: true },
    { source: path.join(home, '.gemini', 'config'), target: `${SANDBOX_HOME}/.gemini/config` }
  ],
  sandbox: {
    envAllow: [],
    envSet: {
      // File-based login, as agy uses over SSH, so the token stays in the mounted state folder.
      SSH_TTY: 'ala-agy-file-auth',
      AGY_CLI_DISABLE_AUTO_UPDATE: '1'
    },
    credentialEnv: []
  },
  login: {
    files: [AGY_TOKEN_FILE],
    // The token file holds the OAuth grant of the Google account; a refresh token or an access token is a login.
    async detect(directory) {
      const stored = await readJson(path.join(directory, AGY_TOKEN_FILE));
      const token = stored?.token;
      return isRecord(token) && (filled(token.refresh_token) || filled(token.access_token));
    }
  },
  nativeInstructions: ({ text, name }) => ({ args: ['--add-dir', `/tmp/${name}`, '--agent', name],
    files: [{ target: `/tmp/${name}/.agents/agents/${name}/agent.md`,
      content: `---\nname: ${name}\ndescription: Session instructions supplied by the caller.\n---\n${text}\n` }] }),
  fullAccess: { args: ['--dangerously-skip-permissions'], env: {} },
  adapter: () => import('./adapter.mjs'),
  sessions: () => import('./sessions.mjs')
});
