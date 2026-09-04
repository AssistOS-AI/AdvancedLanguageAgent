import { ALAError, EXIT_CODES } from '../errors.mjs';

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  const candidate = /^https?:\/\//u.test(raw) ? raw : `http://${raw}/mcp`;
  let parsed;
  try { parsed = new URL(candidate); } catch {
    throw new ALAError(`Invalid MCP server address: ${raw}`, EXIT_CODES.usage);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ALAError(`MCP server must use HTTP or HTTPS: ${raw}`, EXIT_CODES.usage);
  }
  return parsed.toString();
}

export function parseMcpServers(value) {
  if (!value) return [];
  const records = [];
  const names = new Set();
  for (const [index, item] of String(value).split(',').map((part) => part.trim()).filter(Boolean).entries()) {
    const separator = item.indexOf('=');
    const name = separator > 0 ? item.slice(0, separator).trim() : `server${index + 1}`;
    const address = separator > 0 ? item.slice(separator + 1).trim() : item;
    if (!/^[A-Za-z0-9_-]+$/u.test(name) || names.has(name)) {
      throw new ALAError(`Invalid or duplicate MCP server name: ${name}`, EXIT_CODES.usage);
    }
    names.add(name);
    records.push({ name, url: normalizeUrl(address) });
  }
  return records;
}

export function codexMcpOverrides(servers) {
  return servers.flatMap(({ name, url }) => [
    '--config',
    `mcp_servers.${name}.url=${JSON.stringify(url)}`
  ]);
}
