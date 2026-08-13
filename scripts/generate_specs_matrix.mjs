import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
async function findRepoRoot() {
  const candidates = [
    process.cwd(),
    resolve(scriptDir, '..'),
    resolve(scriptDir, '../../../..')
  ];

  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, 'docs/specs'));
      return candidate;
    } catch {
      // Continue through supported installed and skill-local locations.
    }
  }

  throw new Error('Could not locate a repository containing docs/specs.');
}

const repoRoot = await findRepoRoot();
const specsDir = resolve(repoRoot, 'docs/specs');
const matrixPath = resolve(specsDir, 'matrix.md');

function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) {
    return { metadata: {}, body: markdown };
  }

  const endIndex = markdown.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return { metadata: {}, body: markdown };
  }

  const metadata = {};
  for (const line of markdown.slice(4, endIndex).trim().split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      metadata[match[1]] = match[2];
    }
  }

  return {
    metadata,
    body: markdown.slice(endIndex + 5)
  };
}

function parseSummary(metadata, body) {
  if (metadata.summary) {
    return metadata.summary;
  }

  const paragraphs = body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => !chunk.startsWith('#'));

  return paragraphs[0]?.replace(/\s+/g, ' ') ?? '';
}

function requiredMetadata(fileName, metadata, body) {
  return {
    id: metadata.id,
    name: fileName.replace(/\.md$/, ''),
    description: parseSummary(metadata, body),
    fileName
  };
}

function validateContiguousIds(specs) {
  const ids = specs.map((spec) => Number(spec.id.slice(2)));
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index] !== ids[index - 1] + 1) {
      throw new Error(
        `DS numbering is not contiguous: expected DS${String(ids[index - 1] + 1).padStart(3, '0')} after ${specs[index - 1].id}, found ${specs[index].id}.`
      );
    }
  }
}

async function loadSpecs() {
  const entries = await readdir(specsDir, { withFileTypes: true });
  const specFiles = entries
    .filter((entry) => entry.isFile() && /^DS\d{3}-.*\.md$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const specs = [];
  for (const fileName of specFiles) {
    const markdown = await readFile(resolve(specsDir, fileName), 'utf8');
    const { metadata, body } = parseFrontmatter(markdown);
    if (!metadata.id) {
      throw new Error(`${fileName} is missing required frontmatter field "id".`);
    }
    specs.push(requiredMetadata(fileName, metadata, body));
  }

  validateContiguousIds(specs);
  return specs;
}

function renderMatrix(specs) {
  const rows = specs
    .map(
      (spec) =>
        `| [${spec.name}](specsLoader.html?spec=${spec.fileName}) | ${spec.description.replace(/\|/g, '\\|')} |`
    )
    .join('\n');

  return `---
title: Specification Matrix
---

| Name | Description |
| --- | --- |
${rows}
`;
}

async function main() {
  const specs = await loadSpecs();
  const matrixMarkdown = renderMatrix(specs);
  await writeFile(matrixPath, matrixMarkdown);
  console.log(`Updated ${matrixPath}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
