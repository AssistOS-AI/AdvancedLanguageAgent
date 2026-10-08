import { ALAError, EXIT_CODES } from './errors.mjs';
import { validatePermissionMode } from './permission-requests.mjs';

const valueOptions = new Map([
  ['--text', 'text'],
  ['--file', 'file'],
  ['--url', 'url'],
  ['--output', 'output'],
  ['--model', 'model'],
  ['--effort', 'effort'],
  ['--permissions', 'permissionMode'],
  ['--tag', 'tags'],
  ['--reasoning-effort', 'reasoningEffort'],
  ['--model-config', 'modelConfigPath'],
  ['--achilles-path', 'achillesPath'],
  ['--config', 'configPath'],
  ['--agent', 'agent'],
  ['--ca', 'agent'],
  ['--home', 'home'],
  ['--ignore', 'ignoredPaths'],
  ['--session-id', 'sessionId'],
  ['--turn-id', 'turnId'],
  ['--taskFile', 'taskFile'],
  ['--task', 'task'],
  ['--MCPServers', 'mcpServers']
]);

const repeatableOptions = new Set(['tags', 'ignoredPaths']);
const sourceOptions = new Map([
  ['--text', 'text'],
  ['--file', 'file'],
  ['--url', 'url']
]);

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new ALAError(`${option} requires a value.`, EXIT_CODES.usage);
  }
  return value;
}

function defaultExecutionOptions() {
  return {
    command: 'execute',
    instructionParts: [],
    sources: [],
    folders: [],
    ignoredPaths: [],
    tags: [],
    interactive: false,
    permissionMode: 'full-access',
    force: false,
    help: false,
    version: false
  };
}

function parseAlias(argv, index, option) {
  if (argv[index + 1] !== 'as') return { alias: undefined, index };
  return { alias: optionValue(argv, index + 1, `${option} as`), index: index + 2 };
}

function parseAgentCommand(argv) {
  const options = {
    command: 'agent', action: argv[1] || null, json: false, help: false
  };
  if (options.action !== 'list') {
    throw new ALAError('Usage: ala agent list [--json].', EXIT_CODES.usage);
  }
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') options.json = true;
    else if (token === '--help') options.help = true;
    else throw new ALAError(`Unknown agent option: ${token}`, EXIT_CODES.usage);
  }
  return options;
}

export function parseArguments(argv) {
  if (argv[0] === 'agent') return parseAgentCommand(argv);

  const options = defaultExecutionOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--version' || token === '-v') options.version = true;
    else if (token === '--interactive' || token === '-i') options.interactive = true;
    else if (token === '--force') options.force = true;
    else if (token === '--resume-session') options.resumeSession = true;
    else if (token === '--control-stdin') options.controlStdin = true;
    else if (token === '--folder') {
      const source = optionValue(argv, index, token);
      index += 1;
      let writable = false;
      if (argv[index + 1] === 'write') { writable = true; index += 1; }
      const { alias, index: nextIndex } = parseAlias(argv, index, '--folder');
      index = nextIndex;
      let target;
      if (alias === undefined && argv[index + 1] === 'at') {
        target = optionValue(argv, index + 1, '--folder at');
        index += 2;
      }
      const expose = argv[index + 1] === 'expose';
      if (expose) index += 1;
      options.folders.push({ source, ...(writable ? { writable: true } : {}),
        ...(alias !== undefined ? { alias } : {}), ...(target !== undefined ? { target } : {}),
        ...(expose ? { expose: true } : {}) });
    }
    else if (token === '--cwd') {
      const source = optionValue(argv, index, token);
      options.cwd = source;
      index += 1;
      const { alias, index: nextIndex } = parseAlias(argv, index, '--cwd');
      options.cwdAlias = alias;
      index = nextIndex;
    }
    else if (token === '--stdin') options.sources.push({ type: 'stdin' });
    else if (valueOptions.has(token)) {
      const key = valueOptions.get(token);
      const value = optionValue(argv, index, token);
      if (sourceOptions.has(token)) options.sources.push({ type: sourceOptions.get(token), value });
      else if (repeatableOptions.has(key)) options[key].push(value);
      else options[key] = value;
      index += 1;
    } else if (token.startsWith('-')) {
      throw new ALAError(`Unknown option: ${token}`, EXIT_CODES.usage);
    } else {
      options.instructionParts.push(token);
    }
  }
  if (options.task) options.instructionParts.unshift(options.task);
  validatePermissionMode(options.permissionMode);
  if (options.effort !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/u.test(options.effort)) {
      throw new ALAError('--effort requires a native effort name or default.', EXIT_CODES.usage);
    }
    // Effort is a coding-agent override, including when the backend comes from home.
    options.agent ||= 'auto';
  }

  if (options.agent && !['auto', 'codex', 'opencode', 'pi', 'claude'].includes(options.agent)) {
    throw new ALAError('--agent must be auto, codex, opencode, pi, or claude.', EXIT_CODES.usage);
  }
  if (options.agent && (options.tags.length > 0 || options.reasoningEffort || options.modelConfigPath)) {
    throw new ALAError('--ca cannot be combined with tag, reasoning-effort, or model-config overrides.', EXIT_CODES.usage);
  }
  return options;
}

export const HELP_TEXT = `Advanced Language Agent

Usage:
  ala [options] [instruction...]
  ala agent list [--json]

Execution options:
  --ca <name>                Coding agent: auto, codex, opencode, pi, or claude (default: config
                             codingAgent, then the first available of codex, opencode, pi, claude)
  --permissions <mode>       ask-for-approval or full-access (default: full-access)
  --home <path>              Explicit coding-agent home/configuration directory
  --cwd <path> [as <alias>]  Writable working directory; omit to use a retained temporary directory
  --folder <path> [write] [as <alias>|at <absolute-path>] [expose]  Mount a directory; expose opts out of ancestor ignores
  --ignore <absolute-path>  Mask an existing directory with an empty read-only mount (repeatable)
  --session-id <uuid>        Persistent conversation identity; requires --home and --cwd.
                             The transcript is appended to $ALA_SESSIONS/sessions/<uuid>.jsonl
                             (default: <cwd>/.ala)
  --turn-id <id>             Identifier recorded on this turn's transcript records
  --resume-session           Resume the exact saved session, never create a replacement
  --control-stdin            Accept JSONL messages and interaction responses while executing; without
                             --task/--taskFile the first record is the turn prompt:
                             {"type":"prompt","prompt":"...","displayText":"..."}
  --task <prompt>            Task prompt
  --taskFile <path>          UTF-8 file containing a detailed task prompt
  --MCPServers <addresses>   Comma-separated name=URL or host:port MCP servers
  --text <text>              Add a text payload
  --file <path>              Add a UTF-8 file payload
  --url <url>                Add an HTTP(S) UTF-8 payload
  --stdin                    Add standard input as payload
  --output <path>            Write the result to a file
  --force                    Permit overwriting the output file
  --interactive, -i          Start or retain an interactive session
  --model <value>            Override the model or model tag
  --effort <value|default>   Override coding-agent effort; default clears the configured effort
  --tag <tag>                Add a model-selection tag
  --reasoning-effort <value> Override reasoning effort
  --model-config <path>      Override AchillesAgentLib model configuration
  --achilles-path <path>     Override AchillesAgentLib resolution
  --config <path>            Override the ALA configuration file
  Interactive: /help         Show every interactive command and its behavior
  --help, -h                 Show help
  --version, -v              Show version`;
