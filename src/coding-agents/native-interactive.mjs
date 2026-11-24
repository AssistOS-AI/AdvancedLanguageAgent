import path from 'node:path';

import { getAgent } from './registry.mjs';

// These arguments remove native approval gates only. The caller must run the command inside its sandbox.
export function fullAccessPolicy(name) {
  const policy = getAgent(name)?.fullAccess;
  if (!policy) throw new TypeError(`No full-access policy for coding agent: ${name}`);
  return { args: [...policy.args], env: { ...policy.env } };
}

// A command array for an inherited TTY inside an existing sandbox. Apply the environment after login profiles
// have loaded, without shell interpolation, so a profile cannot accidentally restore native approval defaults.
export function buildInteractiveCommand({ agent, binary, args = [] }) {
  if (!path.isAbsolute(binary) || !Array.isArray(args)
      || args.some(arg => typeof arg !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(arg))) {
    throw new TypeError('Invalid native interactive command.');
  }
  const policy = fullAccessPolicy(agent);
  return ['/usr/bin/env', ...Object.entries(policy.env).map(([key, value]) => `${key}=${value}`),
    binary, ...policy.args, ...args];
}
