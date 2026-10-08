import fs from 'node:fs';
import path from 'node:path';
import { ALAError, EXIT_CODES } from '../errors.mjs';

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

// Resolve every exposed source, including aliases that mount an ignored subtree directly.
export function ignoredMountTargets(ignoredPaths, mounts, workingDirectory) {
  const targets = new Set();
  for (const requested of ignoredPaths) {
    let source;
    try {
      if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error();
      source = fs.realpathSync(requested);
      if (!fs.statSync(source).isDirectory()) throw new Error();
    } catch {
      throw new ALAError('--ignore requires an existing absolute directory path.', EXIT_CODES.execution);
    }
    let exposed = false;
    for (const mount of mounts) {
      const mountedSource = fs.realpathSync(mount.source);
      // Explicit exports of strict descendants survive an ancestor ignore.
      // Ignoring the exported directory itself remains authoritative.
      if (mount.expose && source !== mountedSource && contains(source, mountedSource)) continue;
      let target;
      if (contains(mountedSource, source)) {
        target = path.join(mount.target, path.relative(mountedSource, source));
      } else if (contains(source, mountedSource)) target = mount.target;
      else continue;
      exposed = true;
      if (contains(target, workingDirectory)) {
        throw new ALAError('--ignore cannot mask the working directory or its ancestors.', EXIT_CODES.execution);
      }
      targets.add(target);
    }
    if (!exposed) {
      throw new ALAError('--ignore directory is not exposed by a sandbox mount.', EXIT_CODES.execution);
    }
  }
  // An ancestor mask already hides nested mounts; avoid mounting inside a read-only mask.
  return [...targets].filter(target => ![...targets].some(other => other !== target && contains(other, target)));
}
