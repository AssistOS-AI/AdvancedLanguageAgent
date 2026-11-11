import path from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';

// Constant base rules. Every host path below is a -D parameter, never profile text, so no path can inject rules.
//
// Rule order, which the Seatbelt "last match wins" evaluation makes part of the boundary:
//   1. base rules (this text): process, sysctl, Mach, network, devices, terminals, the root folder;
//   2. read-only system roots and the supervisor file;
//   3. file-read-metadata on every parent folder of every allowed root;
//   4. home, temp, mounts, state roots and runtime roots in ascending path length, so an ancestor never
//      overrides a descendant: a state root below a read-only mount stays writable, a read-only folder or an
//      agent installation below a writable root stays read-only;
//   5. masks, after every allow;
//   6. root guards: no granted root can be renamed, swapped, removed or replaced by a link, because a
//      (subpath ROOT) rule also matches ROOT itself;
//   7. link guards: no link on the way to the agent's or Node's program inside a writable root can be replaced;
//   8. rename guards: no folder between a writable root and a root, link or mask nested in it can be renamed.
export const SEATBELT_BASE_RULES = `(version 1)
(deny default)
(allow process-fork)
(allow signal (target same-sandbox))
(deny process-info*)
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(deny sysctl-read (sysctl-name-regex #"^kern\\.proc"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow network-outbound (remote ip "*:*"))
(allow network-inbound (local ip "*:*"))
(allow network-bind (local ip "*:*"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random"))
(allow file-read* file-write* (literal "/dev/urandom") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(allow file-read* file-write* (literal "/dev/ptmx"))
(allow file-ioctl (literal "/dev/ptmx"))
(allow pseudo-tty)
(deny file-read* file-write* (regex #"^/dev/ttys[0-9]+"))
(allow file-read* file-write* file-ioctl (require-all (regex #"^/dev/ttys[0-9]+") (extension "com.apple.sandbox.pty")))
(allow file-read-data file-read-metadata (literal "/"))
(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var"))
`;

const inside = (value, root) => value === root || value.startsWith(`${root}/`);
const strictlyInside = (value, root) => value !== root && inside(value, root);

const wellFormed = (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
  && path.normalize(value) === value && (!value.endsWith('/') || value === '/');

function invalid(name, value) {
  return new ALAError(`Seatbelt profile parameter ${name} must be an absolute, normalized, real path: ${
    JSON.stringify(value)}`, EXIT_CODES.execution);
}

// Folders strictly between root and target, outermost first.
function between(root, target) {
  const folders = [];
  for (let current = path.dirname(target); strictlyInside(current, root); current = path.dirname(current)) {
    folders.unshift(current);
  }
  return folders;
}

function ancestors(value) {
  const result = [];
  for (let current = path.dirname(value); current !== '/'; current = path.dirname(current)) result.unshift(current);
  return result;
}

export function buildSeatbeltProfile({
  systemRoots = [], runtimeRoots = [], mounts = [], masks = [], home, temp, stateRoots = [], supervisor, links = []
}, { realpath = null } = {}) {
  const params = [];
  const names = new Map();
  const counters = new Map();
  // NAME_ prefixes are numbered in order of first use; the same value under the same prefix reuses its name.
  const param = (prefix, value) => {
    const key = `${prefix}\0${value}`;
    if (names.has(key)) return names.get(key);
    const index = counters.get(prefix) ?? 0;
    const name = prefix.endsWith('_') ? `${prefix}${index}` : prefix;
    // A link is named by its own path: only the folder that holds it must be real.
    const real = prefix === 'LINK_' ? (folder) => path.join(realpath(path.dirname(folder)), path.basename(folder))
      : realpath;
    if (!wellFormed(value) || (realpath && real(value) !== value)) throw invalid(name, value);
    counters.set(prefix, index + 1);
    names.set(key, name);
    params.push(`${name}=${value}`);
    return name;
  };
  const ref = (name) => `(param "${name}")`;
  const lines = [SEATBELT_BASE_RULES.trimEnd()];

  const readRoots = systemRoots.map((root) => ['SYSTEM_', root]);
  // A program runs only from where it can be read, so a hidden binary cannot be started either.
  for (const [prefix, root] of readRoots) {
    lines.push(`(allow file-read* process-exec* (subpath ${ref(param(prefix, root))}))`);
  }
  if (supervisor) lines.push(`(allow file-read* (literal ${ref(param('SUPERVISOR', supervisor))}))`);

  // An installation inside a writable root stays read-only; one that is itself a writable root keeps that grant.
  const writableRoots = new Set([home, temp, ...mounts.filter((mount) => mount.writable).map((mount) => mount.source),
    ...stateRoots]);
  const roots = [
    ...(home ? [{ name: 'HOME', path: home, writable: true }] : []),
    ...(temp ? [{ name: 'TEMP', path: temp, writable: true }] : []),
    ...mounts.map((mount) => ({ name: 'MOUNT_', path: mount.source, writable: Boolean(mount.writable) })),
    ...stateRoots.map((root) => ({ name: 'STATE_', path: root, writable: true })),
    ...runtimeRoots.filter((root) => !writableRoots.has(root))
      .map((root) => ({ name: 'RUNTIME_', path: root, writable: false, runtime: true }))
  ].map((root, order) => ({ ...root, order })).sort((left, right) => left.path.length - right.path.length
    || left.order - right.order);

  const allowed = [...readRoots.map(([, root]) => root), ...(supervisor ? [supervisor] : []),
    ...roots.map((root) => root.path)];
  // A malformed root contributes no parents; its own parameter is refused below.
  const parents = [...new Set(allowed.filter(wellFormed).flatMap(ancestors))].sort();
  for (const parent of parents) lines.push(`(allow file-read-metadata (literal ${ref(param('PARENT_', parent))}))`);

  for (const root of roots) {
    const name = ref(param(root.name, root.path));
    if (root.writable) lines.push(`(allow file-read* file-write* process-exec* (subpath ${name}))`);
    else lines.push(`(allow file-read* process-exec* (subpath ${name}))`, `(deny file-write* (subpath ${name}))`);
    // Unix sockets are reachable only below a granted root; an installation is not a granted root.
    if (!root.runtime) lines.push(`(allow network-outbound (subpath ${name}))`);
  }

  for (const mask of masks) {
    const filter = mask.directory ? 'subpath' : 'literal';
    lines.push(`(deny file-read* file-write* process-exec* network-outbound (${filter} ${
      ref(param('MASK_', mask.target))}))`);
  }

  // Renaming, swapping or removing a granted root, or replacing it with a link, would move its rules elsewhere.
  for (const root of roots) lines.push(`(deny file-write-unlink (literal ${ref(param(root.name, root.path))}))`);
  // A link on the way to an agent's or Node's program that lies in a writable root (a standalone install's
  // `current` link inside the agent's state folder, for example) would let a confined run choose the program a
  // later unconfined run starts: it can be neither replaced nor renamed onto. Links outside writable roots need none.
  const writable = roots.filter((root) => root.writable).map((root) => root.path);
  const guardedLinks = [...new Set(links)].filter((link) => writable.some((root) => strictlyInside(link, root)));
  for (const link of guardedLinks) lines.push(`(deny file-write-unlink (literal ${ref(param('LINK_', link))}))`);
  // The same for every folder between a writable root and any root, link or mask nested in it.
  const nested = [...roots.map((root) => root.path), ...guardedLinks, ...masks.map((mask) => mask.target)];
  const guards = new Set();
  for (const target of nested) {
    for (const root of writable) {
      if (strictlyInside(target, root)) for (const folder of between(root, target)) guards.add(folder);
    }
  }
  for (const guard of [...guards].sort()) {
    lines.push(`(deny file-write-unlink (literal ${ref(param('GUARD_', guard))}))`);
  }
  return { profile: `${lines.join('\n')}\n`, params };
}
