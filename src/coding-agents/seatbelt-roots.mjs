import fs from 'node:fs';
import path from 'node:path';

import { collectAgentRuntimeMounts } from './sandbox.mjs';

// Software prefixes whose curated folders are read-only system software inside the Seatbelt sandbox.
// Homebrew's Node links dylibs from other kegs and reads etc/openssl@3, so a single keg is not enough.
export const SOFTWARE_PREFIXES = Object.freeze(['/opt/homebrew', '/usr/local']);
const PREFIX_FOLDERS = Object.freeze(['Cellar', 'opt', 'bin', 'sbin', 'lib', 'libexec', 'share', 'include',
  'Frameworks', 'etc/openssl@3', 'etc/ca-certificates']);
// Never a prefix's whole etc or var: they hold other programs' configuration and state.
const SYSTEM_FOLDERS = Object.freeze(['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/sbin', '/usr/share', '/bin',
  '/sbin', '/System', '/private/etc', '/private/var/select', '/private/var/db/timezone',
  '/Library/Frameworks/Python.framework']);
// xcode-select records the active developer directory here; /usr/bin shims such as python3 run from it.
const DEVELOPER_LINK = '/private/var/db/xcode_select_link';

const inside = (value, root) => value === root || value.startsWith(`${root}/`);

function realDirectory(value, fsImpl) {
  try {
    const resolved = fsImpl.realpathSync(value);
    return fsImpl.statSync(resolved).isDirectory() ? resolved : null;
  } catch { return null; }
}

// Keeps the first occurrence of each root and drops roots inside another root of the list.
function outermost(roots) {
  const unique = [...new Set(roots.filter(Boolean))];
  return unique.filter((root) => !unique.some((other) => other !== root && inside(root, other)));
}

export function existingSoftwarePrefixes({ fsImpl = fs } = {}) {
  return SOFTWARE_PREFIXES.map((prefix) => realDirectory(prefix, fsImpl)).filter(Boolean);
}

// The read-only system and software roots, real-path resolved, for the profile's system read allowlist.
export function seatbeltSystemRoots({ fsImpl = fs } = {}) {
  const roots = [...SYSTEM_FOLDERS, DEVELOPER_LINK].map((candidate) => realDirectory(candidate, fsImpl));
  for (const prefix of existingSoftwarePrefixes({ fsImpl })) {
    for (const folder of PREFIX_FOLDERS) roots.push(realDirectory(path.join(prefix, folder), fsImpl));
  }
  return outermost(roots);
}

// The agent's and Node's runtime folders, minus anything inside a software prefix: an npm-global agent would
// otherwise expose a whole prefix, while the curated prefix folders already cover Homebrew's own software.
export function seatbeltRuntimeRoots(binary, { fsImpl = fs, prefixes = existingSoftwarePrefixes({ fsImpl }) } = {}) {
  const roots = [...collectAgentRuntimeMounts(binary), ...collectAgentRuntimeMounts(process.execPath)];
  return outermost(roots.filter((root) => !prefixes.some((prefix) => inside(root, prefix) || inside(prefix, root))));
}

// PATH inside the sandbox: each runtime root's bin and the root itself, each software prefix's bin, then the system.
export function seatbeltSearchPath(runtimeRoots, {
  fsImpl = fs, prefixes = existingSoftwarePrefixes({ fsImpl })
} = {}) {
  const entries = [];
  for (const root of runtimeRoots) {
    for (const candidate of [path.join(root, 'bin'), root]) {
      if (realDirectory(candidate, fsImpl)) entries.push(candidate);
    }
  }
  for (const prefix of prefixes) {
    const bin = path.join(prefix, 'bin');
    if (realDirectory(bin, fsImpl)) entries.push(bin);
  }
  entries.push('/usr/bin', '/bin');
  return [...new Set(entries)].join(':');
}

// Every symbolic link met while resolving a program's path, in order, each named by its own (real-parent) path:
// for a standalone install, the launcher link in ~/.local/bin and the `current` link in the agent's state folder.
export function linksOnPath(start, { fsImpl = fs } = {}) {
  const links = [];
  let pending = path.resolve(start).split('/').filter(Boolean);
  let current = '/';
  for (let hops = 0; pending.length;) {
    const next = path.join(current, pending.shift());
    let metadata;
    try { metadata = fsImpl.lstatSync(next); } catch { return links; }
    if (!metadata.isSymbolicLink()) {
      current = next;
      continue;
    }
    if ((hops += 1) > 40) return links;
    links.push(next);
    const target = fsImpl.readlinkSync(next);
    pending = [...target.split('/').filter(Boolean), ...pending];
    if (path.isAbsolute(target)) current = '/';
  }
  return links;
}
