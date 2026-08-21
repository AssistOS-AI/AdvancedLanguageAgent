import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

import { ALAError, EXIT_CODES } from './errors.mjs';

export function isGitRepositoryUrl(value) {
  return /^(?:https?|ssh|git|file):\/\//iu.test(value) || /^[^@\s]+@[^:\s]+:.+/u.test(value);
}

export function repositorySourceName(source) {
  let candidate = source;
  try {
    candidate = new URL(source).pathname;
  } catch {
    candidate = source.slice(source.indexOf(':') + 1);
  }
  const name = basename(candidate.replace(/\/+$/u, '')).replace(/\.git$/iu, '') || 'repository';
  return name.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'repository';
}

export function registeredRepositoryName(repositoryPath) {
  return basename(String(repositoryPath).replace(/\/+$/u, ''))
    .replace(/-[a-f0-9]{12}$/iu, '')
    .replace(/\.git$/iu, '');
}

export function managedRepositoryPath(source, env = process.env) {
  const dataRoot = env.XDG_DATA_HOME
    ? resolve(env.XDG_DATA_HOME)
    : resolve(env.HOME || homedir(), '.local', 'share');
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return resolve(dataRoot, 'ala', 'repositories', `${repositorySourceName(source)}-${digest}`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args, env, failureMessage) {
  await new Promise((resolveClone, rejectClone) => {
    const child = spawn('git', args, {
      env,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    child.once('error', (error) => rejectClone(new ALAError(
      'Git could not start while managing the task repository.',
      EXIT_CODES.repository,
      { cause: error }
    )));
    child.once('close', (code) => {
      if (code === 0) resolveClone();
      else rejectClone(new ALAError(failureMessage, EXIT_CODES.repository));
    });
  });
}

async function cloneRepository(source, destination, env) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await runGit(['clone', '--depth', '1', source, destination], env, 'Git could not clone the task repository.');
  await runGit(
    ['-C', destination, 'remote', 'remove', 'origin'],
    env,
    'Git could not secure the managed task repository clone.'
  );
}

export async function prepareRepositorySource(source, env = process.env) {
  const destination = managedRepositoryPath(source, env);
  if (await pathExists(destination)) return { repositoryPath: await realpath(destination), created: false };
  try {
    await cloneRepository(source, destination, env);
    return { repositoryPath: await realpath(destination), created: true };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
