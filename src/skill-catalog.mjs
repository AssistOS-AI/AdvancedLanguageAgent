import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { discoverTaskSkills } from './repositories.mjs';
import { ALAError, EXIT_CODES } from './errors.mjs';

/** A caller-owned manifest grants access only to the listed self-contained skill directories. */
export async function readSkillCatalog(file) {
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
