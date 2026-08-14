import { writeFile } from 'node:fs/promises';

import { ALAError, EXIT_CODES } from './errors.mjs';

export function normalizeResult(value) {
  const result = value && typeof value === 'object' && Object.hasOwn(value, 'result') ? value.result : value;
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

export async function writeResult(result, { outputPath, force = false, stdout = process.stdout } = {}) {
  const text = normalizeResult(result);
  const rendered = text.endsWith('\n') ? text : `${text}\n`;
  if (!outputPath) {
    stdout.write(rendered);
    return;
  }
  try {
    await writeFile(outputPath, rendered, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (error) {
    const message = error?.code === 'EEXIST'
      ? `Output file already exists; use --force to overwrite it: ${outputPath}`
      : `Could not write output file ${outputPath}: ${error.message}`;
    throw new ALAError(message, EXIT_CODES.input, { cause: error });
  }
}
