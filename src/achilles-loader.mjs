import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ALAError, EXIT_CODES } from './errors.mjs';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDir, '..');

async function exists(candidate) {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function entryFromPath(candidate, cwd) {
  const absolute = resolve(cwd, candidate);
  if (!await exists(absolute)) return null;
  if (absolute.endsWith('.mjs') || absolute.endsWith('.js')) return absolute;
  const packagePath = resolve(absolute, 'package.json');
  if (await exists(packagePath)) {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    return resolve(absolute, manifest.module || manifest.main || 'index.mjs');
  }
  return resolve(absolute, 'index.mjs');
}

export async function loadAchillesAgentLib({ overridePath, env = process.env, cwd = process.cwd() } = {}) {
  const manualPath = overridePath || env.ACHILLES_AGENT_LIB_PATH;
  if (manualPath) {
    const entry = await entryFromPath(manualPath, cwd);
    if (!entry || !await exists(entry)) {
      throw new ALAError(`Could not resolve AchillesAgentLib from ${manualPath}.`, EXIT_CODES.repository);
    }
    return { module: await import(pathToFileURL(entry).href), strategy: 'manual-override', entry };
  }

  const sibling = resolve(packageRoot, '..', 'AchillesAgentLib');
  const siblingEntry = await entryFromPath(sibling, packageRoot);
  if (siblingEntry && await exists(siblingEntry)) {
    return {
      module: await import(pathToFileURL(siblingEntry).href),
      strategy: 'parent-directory',
      entry: siblingEntry
    };
  }

  try {
    const localRequire = createRequire(resolve(packageRoot, 'package.json'));
    const entry = localRequire.resolve('ploinky-agent-lib');
    return { module: await import(pathToFileURL(entry).href), strategy: 'package', entry };
  } catch (error) {
    throw new ALAError(
      'Could not resolve AchillesAgentLib. Install dependencies or provide --achilles-path.',
      EXIT_CODES.repository,
      { cause: error }
    );
  }
}
