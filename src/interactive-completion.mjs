const COMMANDS = Object.freeze(['/help', '/agent', '/permissions', '/websearch', '/quit', '/exit']);

export function createInteractiveCompleter() {
  return (line) => {
    const input = String(line);
    if (!input.startsWith('/')) return [[], input];
    const candidates = COMMANDS.filter((command) => command.startsWith(input) && command !== input);
    return [candidates, input];
  };
}
