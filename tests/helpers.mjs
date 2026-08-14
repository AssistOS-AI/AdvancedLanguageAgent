import { mkdir, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { join } from 'node:path';

export function captureStream() {
  let content = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      content += chunk.toString();
      callback();
    }
  });
  stream.read = () => content;
  return stream;
}

export function inputStream(content = '', { tty = false } = {}) {
  const stream = Readable.from([content]);
  stream.isTTY = tty;
  return stream;
}

export async function writeCodeSkill(root, name, actionSource = 'return args.promptText;') {
  const skillDir = join(root, 'skills', name);
  await mkdir(join(skillDir, 'src'), { recursive: true });
  const descriptor = `# ${name}\n\n## Description\n${name} test skill.\n\n## Input Format\nPlain text.\n`;
  await writeFile(join(skillDir, 'cskill.md'), descriptor);
  await writeFile(join(skillDir, 'src', 'index.mjs'), `export async function action(args) { ${actionSource} }\n`);
  return skillDir;
}
