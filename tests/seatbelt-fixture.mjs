// Shared fixture for the live Seatbelt test files. Every process is a shell, perl, python or Node fixture.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';

export const skip = process.platform === 'darwin' ? false : 'Seatbelt is macOS-only';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return true;
  return check();
}

// A canonical scratch root with a workspace, a home, a state folder and a folder no grant reaches.
export function fixture(t, base = os.tmpdir()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'ala-sr-')));
  t.after(() => {
    // A test may leave a 0555 directory behind; restore access before removing the fixture.
    spawnSync('/bin/chmod', ['-R', 'u+rwx', root]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = { root };
  for (const name of ['work', 'home', 'state', 'outside']) {
    f[name] = path.join(root, name);
    fs.mkdirSync(f[name]);
  }
  fs.writeFileSync(path.join(f.state, 'auth.json'), '{}');
  fs.writeFileSync(path.join(f.outside, 'victim.txt'), 'victim');
  f.env = { HOME: f.home, CODEX_HOME: f.state, PATH: '/usr/bin:/bin', LANG: 'C' };
  return f;
}

// A service whose injected runner starts { binary, args } through the real sandboxed runProcess.
export function service(f, options = {}) {
  return createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/bin/sh' }], workspace: f.work, cwd: f.work, env: f.env,
    ...options,
    runners: { codex: async (input) => {
      const { binary, args } = JSON.parse(input.prompt);
      const result = await runProcess({ binary, args, cwd: input.workspace, env: input.env, sandbox: input.sandbox,
        signal: input.signal });
      return { outputText: JSON.stringify(result), continuation: null };
    } }
  });
}

export async function execute(instance, binary, args) {
  return JSON.parse(await instance.execute(JSON.stringify({ binary, args })));
}

export async function run(f, binary, args, options = {}) {
  const instance = service(f, options);
  try { return await execute(instance, binary, args); } finally { await instance.close(); }
}

// Perl prints one result per attempt: "ok", or "ERR <message>". The same code runs unconfined as the control.
export const PERL_PRELUDE = 'sub t { my ($ok) = @_; return $ok ? "ok" : "ERR $!"; } ';

export function hostPerl(code, args = [], env = process.env) {
  return spawnSync('/usr/bin/perl', ['-e', PERL_PRELUDE + code, ...args], { encoding: 'utf8', env }).stdout.trim();
}

export async function sandboxPerl(f, code, args = [], options = {}) {
  const result = await run(f, '/usr/bin/perl', ['-e', PERL_PRELUDE + code, ...args], options);
  return result.stdout.trim() || result.stderr.trim();
}
