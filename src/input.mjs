import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ALAError, EXIT_CODES } from './errors.mjs';

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const URL_TIMEOUT_MS = 30_000;

export async function readStream(stream, limit = MAX_SOURCE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new ALAError(`Input exceeds the ${limit}-byte source limit.`, EXIT_CODES.input);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readFileSource(filePath, cwd) {
  const absolutePath = resolve(cwd, filePath);
  let handle;
  try {
    handle = await open(absolutePath, 'r');
    const stats = await handle.stat();
    if (stats.size > MAX_SOURCE_BYTES) {
      throw new ALAError(
        `Input file exceeds the ${MAX_SOURCE_BYTES}-byte source limit: ${absolutePath}`,
        EXIT_CODES.input
      );
    }
    return { content: await readFile(handle, 'utf8'), label: `file:${absolutePath}` };
  } catch (error) {
    if (error instanceof ALAError) throw error;
    throw new ALAError(
      `Could not read input file ${absolutePath}: ${error.message}`,
      EXIT_CODES.input,
      { cause: error }
    );
  } finally {
    await handle?.close();
  }
}

async function readUrlSource(url, fetchImpl) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new ALAError(`Invalid input URL: ${url}`, EXIT_CODES.input, { cause: error });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ALAError(`Input URL must use HTTP or HTTPS: ${url}`, EXIT_CODES.input);
  }
  try {
    const response = await fetchImpl(parsed, { signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
      throw new ALAError(
        `URL response exceeds the ${MAX_SOURCE_BYTES}-byte source limit: ${url}`,
        EXIT_CODES.input
      );
    }
    const content = response.body ? await readStream(response.body, MAX_SOURCE_BYTES) : '';
    return { content, label: `url:${parsed.href}` };
  } catch (error) {
    if (error instanceof ALAError) throw error;
    throw new ALAError(`Could not read input URL ${url}: ${error.message}`, EXIT_CODES.input, { cause: error });
  }
}

export async function loadRequest({
  instructionParts,
  sources,
  stdin,
  cwd = process.cwd(),
  fetchImpl = fetch
}) {
  let instruction = instructionParts.join(' ').trim();
  let stdinContent = null;
  const loadedSources = [];

  if (!instruction) {
    stdinContent = await readStream(stdin);
    instruction = stdinContent.trim();
    if (!instruction) throw new ALAError('An instruction is required.', EXIT_CODES.usage);
  }

  for (const source of sources) {
    let loaded;
    if (source.type === 'text') loaded = { content: source.value, label: 'text' };
    else if (source.type === 'file') loaded = await readFileSource(source.value, cwd);
    else if (source.type === 'url') loaded = await readUrlSource(source.value, fetchImpl);
    else if (source.type === 'stdin') {
      if (instructionParts.length === 0) continue;
      if (stdinContent === null) stdinContent = await readStream(stdin);
      loaded = { content: stdinContent, label: 'stdin' };
    }
    if (loaded) loadedSources.push(loaded);
  }

  if (!instruction) throw new ALAError('An instruction is required.', EXIT_CODES.usage);
  const totalBytes = loadedSources.reduce((total, source) => total + Buffer.byteLength(source.content), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new ALAError(`Payload exceeds the ${MAX_TOTAL_BYTES}-byte aggregate limit.`, EXIT_CODES.input);
  }
  return { instruction, sources: loadedSources };
}

export function composePrompt(request) {
  if (request.sources.length === 0) return request.instruction;
  const payload = request.sources
    .map((source, index) => `--- input ${index + 1} (${source.label}) ---\n${source.content}`)
    .join('\n\n');
  return `Instruction:\n${request.instruction}\n\nInputs:\n${payload}`;
}
