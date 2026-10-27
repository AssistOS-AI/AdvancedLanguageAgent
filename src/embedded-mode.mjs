import { stat } from 'node:fs/promises';
import path from 'node:path';

import { ALAError, EXIT_CODES } from './errors.mjs';
import { ROBOT_HOME } from './coding-agents/provider.mjs';
import { requireVirtualPath, resolveVirtualHome } from './coding-agents/virtual-paths.mjs';

// Embedded mode is the execution with a protocol provider. The provider owns the filesystem the workload sees, so
// ALA performs no operation on workload paths and refuses every input that would make it read or write one. Paths
// for HOME, the working directory and folders are virtual; the managed configuration and the session storage are
// the orchestration domain's own files.

const REFUSED = Object.freeze([
  ['file', '--file'], ['url', '--url']
]);

function refuse(message) {
  return new ALAError(`${message} is not available when an execution provider owns the filesystem.`, EXIT_CODES.usage);
}

// Static refusals that need no filesystem access. Content must reach ALA over the control stream (the prompt, a
// `--text` value or `--stdin`), not through a path or a URL.
export function refuseEmbeddedOptions(options) {
  for (const [type, flag] of REFUSED) {
    if (options.sources.some((source) => source.type === type)) throw refuse(flag);
  }
  if (options.taskFile) throw refuse('--taskFile');
  if (options.output) throw refuse('--output');
  if (options.cwdAlias !== undefined) throw refuse('--cwd as');
}

// The embedded requirements of section 5.3: an explicit absolute session location, so a transcript can never
// default into the working directory, and an explicit managed configuration file that exists.
export async function requireEmbeddedLocations(options, env) {
  const sessions = String(env.ALA_SESSIONS || '').trim();
  if (!sessions || !path.isAbsolute(sessions)) {
    throw new ALAError('An execution provider requires ALA_SESSIONS to name an absolute private session directory.',
      EXIT_CODES.usage);
  }
  if (!options.configPath || !path.isAbsolute(options.configPath)) {
    throw new ALAError('An execution provider requires --config to name the absolute managed configuration file.',
      EXIT_CODES.usage);
  }
  let metadata;
  try { metadata = await stat(options.configPath); } catch { metadata = null; }
  if (!metadata?.isFile()) {
    throw new ALAError(`The managed configuration file is unavailable: ${options.configPath}`, EXIT_CODES.usage);
  }
}

// Virtual HOME and working directory. Nothing is canonicalized or checked in ALA's filesystem.
export function embeddedPaths(options) {
  if (options.cwd !== undefined) requireVirtualPath(options.cwd, '--cwd');
  return {
    executionCwd: options.cwd ?? null,
    executionHome: options.home ? resolveVirtualHome(options.home) : ROBOT_HOME
  };
}

// Interactive commands that would change the stored backend, model or effort, or inspect the host's logins.
export function embeddedCommandError(command) {
  return new ALAError(`${command} is not available when an execution provider owns the configuration: the managed `
    + 'configuration is read-only, and changes go through the worker\'s configure operation.', EXIT_CODES.usage);
}
