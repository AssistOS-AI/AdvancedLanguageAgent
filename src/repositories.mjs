import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ALAError, EXIT_CODES } from './errors.mjs';

const descriptorNames = new Set(['cskill.md', 'oskill.md', 'tskill.md', 'dcgskill.md']);
const ignoredDirectories = new Set(['.git', 'node_modules']);

async function isSkillsDirectory(candidate) {
  try {
    const entries = await readdir(candidate, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

export async function findSkillsDirectories(repositoryPath) {
  const root = await realpath(repositoryPath);
  const queue = [root];
  const results = [];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (basename(current) === 'skills' && await isSkillsDirectory(current)) {
      results.push(current);
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      queue.push(join(current, entry.name));
    }
  }
  return results;
}

async function countDescriptors(directory) {
  let count = 0;
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && descriptorNames.has(entry.name)) count += 1;
      else if (entry.isDirectory()) queue.push(join(current, entry.name));
    }
  }
  return count;
}

export async function validateTaskRepository(repositoryPath) {
  const skillsDirectories = await findSkillsDirectories(repositoryPath);
  let descriptorCount = 0;
  for (const directory of skillsDirectories) descriptorCount += await countDescriptors(directory);
  if (descriptorCount === 0) {
    throw new ALAError(
      `Task repository contains no AchillesAgentLib skill descriptors: ${repositoryPath}`,
      EXIT_CODES.repository
    );
  }
  return { repositoryPath: await realpath(repositoryPath), skillsDirectories, descriptorCount };
}

export async function createSkillRegistry(repositoryPaths, achillesModule) {
  const records = [];
  const validations = [];
  for (const repositoryPath of repositoryPaths) {
    const validation = await validateTaskRepository(repositoryPath);
    validations.push(validation);
    const discovered = achillesModule.discoverSkills(repositoryPath, { logger: silentLogger });
    if (discovered.length === 0) {
      throw new ALAError(`AchillesAgentLib discovered no A-Skills in ${repositoryPath}.`, EXIT_CODES.repository);
    }
    records.push(...discovered.map((record) => ({ ...record, repositoryPath })));
  }

  const names = new Map();
  for (const record of records) {
    if (names.has(record.name)) {
      throw new ALAError(
        `Duplicate A-Skill name "${record.name}" in ${names.get(record.name)} and ${record.repositoryPath}.`,
        EXIT_CODES.repository
      );
    }
    names.set(record.name, record.repositoryPath);
  }

  const registryPath = await mkdtemp(join(tmpdir(), 'ala-skills-'));
  try {
    let sourceIndex = 0;
    for (const validation of validations) {
      for (const skillsDirectory of validation.skillsDirectories) {
        const wrapperPath = resolve(registryPath, `source-${sourceIndex}`);
        await mkdir(wrapperPath);
        await symlink(
          skillsDirectory,
          resolve(wrapperPath, 'skills'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
        sourceIndex += 1;
      }
    }
  } catch (error) {
    await rm(registryPath, { recursive: true, force: true });
    throw error;
  }

  return {
    path: registryPath,
    skills: records,
    async cleanup() {
      await rm(registryPath, { recursive: true, force: true });
    }
  };
}

const silentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {}
});
