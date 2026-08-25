import { StringDecoder } from 'node:string_decoder';

export const OUTPUT_TAIL_LIMIT = 16 * 1024;

export function appendBoundedTail(current, chunk, limit = OUTPUT_TAIL_LIMIT) {
  const next = Buffer.concat([
    Buffer.from(String(current || ''), 'utf8'),
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8')
  ]);
  let start = Math.max(0, next.length - limit);
  while (start < next.length && (next[start] & 0xc0) === 0x80) start += 1;
  return next.subarray(start).toString('utf8');
}

export function createLineDecoder(onLine) {
  const decoder = new StringDecoder('utf8');
  let buffered = '';

  const consume = (text) => {
    buffered += text;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      onLine(buffered.slice(0, newline).replace(/\r$/u, ''));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  };

  return {
    push(chunk) { consume(decoder.write(chunk)); },
    finish() {
      consume(decoder.end());
      if (buffered) onLine(buffered.replace(/\r$/u, ''));
      buffered = '';
    }
  };
}

export function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if ('content' in value) return contentText(value.content);
  return '';
}

export function unseenText(previous, next) {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.endsWith(next)) return '';
  for (let overlap = Math.min(previous.length, next.length); overlap > 0; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) return next.slice(overlap);
  }
  return next;
}
