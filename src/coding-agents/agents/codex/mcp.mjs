export function codexMcpOverrides(servers) {
  return servers.flatMap(({ name, url }) => [
    '--config',
    `mcp_servers.${name}.url=${JSON.stringify(url)}`
  ]);
}
