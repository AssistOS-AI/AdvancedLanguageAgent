import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ALAError, EXIT_CODES } from './errors.mjs';

const ignoredDirectories = new Set(['.git', 'node_modules']);
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function scalarValue(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function frontmatterFields(source) {
  const match = String(source).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/u);
  const fields = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u);
    if (!field) continue;
    let value = field[2] || '';
    if (value === '>' || value === '|') {
      const continuation = [];
      while (index + 1 < lines.length && /^\s+/u.test(lines[index + 1])) {
        continuation.push(lines[index + 1].trim());
        index += 1;
      }
      value = continuation.join(value === '>' ? ' ' : '\n');
    }
    fields.set(field[1].toLowerCase(), scalarValue(value));
  }
  return fields;
}

async function skillRecord(filePath, repositoryPath) {
  const fields = frontmatterFields(await readFile(filePath, 'utf8'));
  const name = fields?.get('name') || '';
  const description = fields?.get('description') || '';
  if (!skillNamePattern.test(name) || !description) {
    throw new ALAError(
      `Anthropic skill descriptor must define a lowercase hyphenated name and description: ${filePath}`,
      EXIT_CODES.repository
    );
  }
  return {
    name,
    shortName: name,
    description,
    filePath,
    directoryPath: dirname(filePath),
    repositoryPath
  };
}

export async function discoverAnthropicSkills(repositoryPath) {
  const root = await realpath(repositoryPath);
  const queue = [root];
  const records = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isFile() && entry.name === 'SKILL.md') records.push(await skillRecord(entryPath, root));
      else if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) queue.push(entryPath);
    }
  }
  return records;
}

export async function validateTaskRepository(repositoryPath) {
  const canonicalPath = await realpath(repositoryPath);
  const skills = await discoverAnthropicSkills(canonicalPath);
  if (skills.length === 0) {
    throw new ALAError(
      `Task repository contains no Anthropic SKILL.md descriptors: ${canonicalPath}`,
      EXIT_CODES.repository
    );
  }
  return { repositoryPath: canonicalPath, skills, descriptorCount: skills.length };
}

export async function discoverTaskSkills(repositoryPaths) {
  const records = [];
  for (const repositoryPath of repositoryPaths) {
    const validation = await validateTaskRepository(repositoryPath);
    records.push(...validation.skills);
  }

  const names = new Map();
  for (const record of records) {
    if (names.has(record.name)) {
      throw new ALAError(
        `Duplicate task-skill name "${record.name}" in ${names.get(record.name)} and ${record.repositoryPath}.`,
        EXIT_CODES.repository
      );
    }
    names.set(record.name, record.repositoryPath);
  }
  if (names.has('coding-agent')) {
    throw new ALAError('Task-skill name is reserved by ALA: coding-agent', EXIT_CODES.repository);
  }

  return records;
}

export async function createSkillRegistry(repositoryPaths, { builtInSkillsDirectories = [] } = {}) {
  const records = await discoverTaskSkills(repositoryPaths);

  const registryPath = await mkdtemp(join(tmpdir(), 'ala-skills-'));
  try {
    let sourceIndex = 0;
    for (const skillsDirectory of builtInSkillsDirectories) {
      const wrapperPath = resolve(registryPath, `source-${sourceIndex}`);
      await mkdir(wrapperPath);
      await symlink(skillsDirectory, resolve(wrapperPath, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
      sourceIndex += 1;
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
