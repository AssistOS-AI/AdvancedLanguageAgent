import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ALAError, EXIT_CODES } from './errors.mjs';
import { discoverAnthropicSkills, discoverTaskSkills } from './repositories.mjs';

const invalid = (message) => new ALAError(`Invalid execution skill catalog: ${message}`, EXIT_CODES.repository);

async function legacyRevision(directory, { allowLinks = false, bounded = true } = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  let files = 0;
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      const file = join(current, name);
      const info = await lstat(file);
      if ((!allowLinks && info.isSymbolicLink()) || (!info.isSymbolicLink() && !info.isFile() && !info.isDirectory())) {
        throw invalid(`unsupported file: ${relative(directory, file)}`);
      }
      files += 1;
      bytes += info.isFile() ? info.size : 0;
      if (bounded && (files > 10000 || bytes > 64 * 1024 * 1024)) {
        throw invalid('legacy catalog exceeds 64 MiB or 10000 entries');
      }
      hash.update(JSON.stringify([relative(directory, file), info.isDirectory(), info.isSymbolicLink(),
        info.mode & 0o111, info.isDirectory() ? null : info.size]));
      if (info.isSymbolicLink()) hash.update(await readlink(file));
      else if (info.isDirectory()) await visit(file);
      else for await (const chunk of createReadStream(file)) hash.update(chunk);
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

async function readSkillManifest(file) {
  try {
    const paths = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string'
        || !isAbsolute(value) || value.includes('\0'))) {
      throw new Error('expected a JSON array of absolute skill directory paths');
    }
    const directories = [...new Set(await Promise.all(paths.map(directory => realpath(directory))))];
    for (const directory of directories) {
      if (!(await stat(directory)).isDirectory() || !(await stat(join(directory, 'SKILL.md'))).isFile()) {
        throw new Error(`expected a skill directory with SKILL.md: ${directory}`);
      }
      const skills = await discoverTaskSkills([directory]);
      if (skills.length !== 1 || skills[0].directoryPath !== directory) {
        throw new Error(`nested skill descriptors are not supported: ${directory}`);
      }
    }
    await discoverTaskSkills(directories);
    return directories;
  } catch (error) {
    throw new ALAError(`Invalid --skill-catalog manifest: ${error.message}`, EXIT_CODES.repository);
  }
}

/** Select only caller-owned paths; an explicit empty catalog never adds a repository. */
export async function readSkillCatalog(file) {
  let info;
  try { info = await stat(file); }
  catch (error) {
    throw new ALAError(`Invalid --skill-catalog manifest: ${error.message}`, EXIT_CODES.repository);
  }
  if (!info.isDirectory()) return readSkillManifest(file);
  const directory = await realpath(file);
  if (directory !== resolve(file)) throw invalid('catalog directory must use its canonical path');
  const skills = await discoverAnthropicSkills(directory);
  if (skills.length) await discoverTaskSkills([directory]);
  await readCatalogEnvelope(directory, skills);
  return skills.length ? [directory] : [];
}

async function manifestEnvelope(file, skills) {
  const directories = await readSkillManifest(file);
  const actual = await discoverTaskSkills(directories);
  if (actual.length !== skills.length || actual.some(record => !skills.some(skill =>
    skill.name === record.name && skill.directoryPath === record.directoryPath))) {
    throw invalid('descriptor membership changed while reading the manifest');
  }
  const hashes = [];
  for (const directory of [...directories].sort()) {
    // Manifest directories retain their existing symlink behavior. Hash link text
    // without following it outside the selected directory or adding a source.
    hashes.push([directory, await legacyRevision(directory, { allowLinks: true, bounded: false })]);
  }
  return { version: 1, revision: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
    policyVersion: null, entries: skills.map(({ name }) => ({ name, identity: name })), diagnostics: [] };
}

export async function readCatalogEnvelope(directory, skills) {
  try {
    if (!(await stat(directory)).isDirectory()) return await manifestEnvelope(directory, skills);
    if (await realpath(directory) !== resolve(directory)) throw invalid('catalog directory must use its canonical path');
  } catch (error) {
    if (error instanceof ALAError) throw error;
    throw invalid(error.message);
  }
  let metadata;
  try {
    const file = join(directory, '.catalog.json');
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw invalid('metadata must be a regular file below 1 MiB');
    metadata = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw invalid(error.message);
    return { version: 1, revision: await legacyRevision(directory), policyVersion: null,
      entries: skills.map(({ name }) => ({ name, identity: name })), diagnostics: [] };
  }
  if (metadata?.version !== 1 || typeof metadata.revision !== 'string' || !metadata.revision.trim()
      || metadata.revision.length > 256 || !Number.isSafeInteger(metadata.policyVersion)
      || metadata.policyVersion < 0 || !Array.isArray(metadata.entries) || !Array.isArray(metadata.diagnostics)) {
    throw invalid('expected version 1, revision, policyVersion, entries and diagnostics');
  }
  const names = new Set();
  const identities = new Set();
  for (const entry of metadata.entries) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.identity !== 'string' || !entry.identity
        || names.has(entry.name) || identities.has(entry.identity)) throw invalid('invalid or duplicate catalog identity');
    const record = skills.find((skill) => skill.name === entry.name);
    if (!record || relative(directory, record.filePath) !== join(entry.name, 'SKILL.md')) {
      throw invalid(`missing or nested descriptor: ${entry.name}`);
    }
    names.add(entry.name);
    identities.add(entry.identity);
  }
  if (names.size !== skills.length) throw invalid('descriptor membership differs from the catalog envelope');
  return { version: 1, revision: metadata.revision, policyVersion: metadata.policyVersion,
    entries: metadata.entries.map(({ name, identity }) => ({ name, identity })), diagnostics: metadata.diagnostics };
}

export function filterTaskSkills(skills, selection) {
  if (selection === undefined || selection === null) return skills;
  const requested = [...new Set(String(selection).split(',').map((name) => name.trim()).filter(Boolean))];
  const filtered = skills.filter((skill) => requested.includes(skill.name));
  const missing = requested.filter((name) => !filtered.some((skill) => skill.name === name));
  if (missing.length) throw new ALAError(`Task skills not found: ${missing.join(', ')}`, EXIT_CODES.repository);
  return filtered;
}

export function restrictCatalogEnvelope(catalog, skills) {
  if (!catalog) return null;
  const entries = catalog.entries.filter((entry) => skills.some((skill) => skill.name === entry.name));
  if (entries.length === catalog.entries.length) return catalog;
  const revision = createHash('sha256').update(JSON.stringify([catalog.revision, entries])).digest('hex');
  return { ...catalog, revision, entries };
}
