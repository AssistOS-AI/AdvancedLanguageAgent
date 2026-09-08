import fs from 'node:fs';
import path from 'node:path';

// Explicit opt-in only: provide the existing Ploinky SDK to task scripts.
// Credentials stay in the private configuration file, never bwrap arguments.
export function addPloinkyTaskMounts(args, directory) {
  if (!directory) return;
  const root = fs.realpathSync(directory);
  if (root !== path.resolve(directory) || !fs.statSync(root).isDirectory()) throw new Error('Invalid --ploinky-task directory.');
  const context = JSON.parse(fs.readFileSync(path.join(root, 'context.json'), 'utf8'));
  if (context.version !== 1 || !context.env || typeof context.env !== 'object') throw new Error('Invalid Ploinky task context.');
  const eventPath = path.join(root, 'events');
  if (fs.realpathSync(eventPath) !== eventPath || !fs.statSync(eventPath).isDirectory()) throw new Error('Invalid Ploinky task events directory.');
  const bind = (source, target = source, writable = false) => {
    if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error('Ploinky SDK paths must be absolute.');
    const canonical = fs.realpathSync(source);
    const parents = [];
    for (let parent = path.dirname(target); parent !== '/'; parent = path.dirname(parent)) parents.unshift(parent);
    for (const parent of parents) args.push('--dir', parent);
    args.push(writable ? '--bind' : '--ro-bind', canonical, target);
  };
  // No entire workspace/private data directory is mounted for SDK discovery.
  bind(root, '/run/ploinky-task');
  bind(path.join(root, 'events'), '/run/ploinky-task/events', true);
  if (context.env.PLOINKY_AGENT_ID) {
    bind('/Agent');
    for (const key of ['PLOINKY_AGENTLIB_DIR', 'PLOINKY_ROUTER_DESCRIPTOR_FILE', 'PLOINKY_EDGE_TOPOLOGY_FILE']) {
      if (!context.env[key]) throw new Error(`Ploinky task is missing ${key}.`);
      bind(context.env[key]);
    }
  }
}
