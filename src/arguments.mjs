import { ALAError, EXIT_CODES } from './errors.mjs';

const valueOptions = new Map([
  ['--skill', 'skill'],
  ['--task-repo', 'taskRepositories'],
  ['--text', 'text'],
  ['--file', 'file'],
  ['--url', 'url'],
  ['--output', 'output'],
  ['--model', 'model'],
  ['--tag', 'tags'],
  ['--reasoning-effort', 'reasoningEffort'],
  ['--model-config', 'modelConfigPath'],
  ['--achilles-path', 'achillesPath'],
  ['--config', 'configPath'],
  ['--agent', 'agent']
]);

const repeatableOptions = new Set(['taskRepositories', 'tags']);
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
    taskRepositories: [],
    tags: [],
    interactive: false,
    force: false,
    help: false,
    version: false
  };
}

function parseRepoCommand(argv) {
  const options = {
    command: 'repo',
    action: argv[1] || null,
    target: null,
    configPath: null,
    json: false,
    help: false
  };

  if (!['add', 'remove', 'list'].includes(options.action)) {
    throw new ALAError('Usage: ala repo <add|remove|list> [path] [--config <path>] [--json].', EXIT_CODES.usage);
  }

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') {
      options.configPath = optionValue(argv, index, token);
      index += 1;
    } else if (token === '--json' && options.action === 'list') {
      options.json = true;
    } else if (token === '--help') {
      options.help = true;
    } else if (token.startsWith('-')) {
      throw new ALAError(`Unknown repository option: ${token}`, EXIT_CODES.usage);
    } else if (options.target === null) {
      options.target = token;
    } else {
      throw new ALAError(`Unexpected repository argument: ${token}`, EXIT_CODES.usage);
    }
  }

  if (['add', 'remove'].includes(options.action) && !options.target && !options.help) {
    throw new ALAError(`ala repo ${options.action} requires a repository path.`, EXIT_CODES.usage);
  }
  if (options.action === 'list' && options.target) {
    throw new ALAError('ala repo list does not accept a repository path.', EXIT_CODES.usage);
  }
  return options;
}

function parseAgentCommand(argv) {
  const options = {
    command: 'agent', action: argv[1] || null, configPath: null, json: false, help: false
  };
  if (options.action !== 'list') {
    throw new ALAError('Usage: ala agent list [--config <path>] [--json].', EXIT_CODES.usage);
  }
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') {
      options.configPath = optionValue(argv, index, token);
      index += 1;
    } else if (token === '--json') options.json = true;
    else if (token === '--help') options.help = true;
    else throw new ALAError(`Unknown agent option: ${token}`, EXIT_CODES.usage);
  }
  return options;
}

export function parseArguments(argv) {
  if (argv[0] === 'repo') return parseRepoCommand(argv);
  if (argv[0] === 'agent') return parseAgentCommand(argv);

  const options = defaultExecutionOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--version' || token === '-v') options.version = true;
    else if (token === '--interactive' || token === '-i') options.interactive = true;
    else if (token === '--force') options.force = true;
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
  if (options.agent && !['auto', 'codex', 'opencode', 'pi'].includes(options.agent)) {
    throw new ALAError('--agent must be auto, codex, opencode, or pi.', EXIT_CODES.usage);
  }
  if (options.agent && options.skill) {
    throw new ALAError('--agent and --skill cannot be used together.', EXIT_CODES.usage);
  }
  if (options.agent && (options.model || options.tags.length > 0 || options.reasoningEffort || options.modelConfigPath)) {
    throw new ALAError(
      '--agent cannot be combined with model, tag, reasoning-effort, or model-config overrides.',
      EXIT_CODES.usage
    );
  }
  return options;
}

export const HELP_TEXT = `Advanced Language Agent

Usage:
  ala [options] [instruction...]
  ala repo add <path> [--config <path>]
  ala repo remove <path> [--config <path>]
  ala repo list [--config <path>] [--json]
  ala agent list [--config <path>] [--json]

Execution options:
  --skill <name>             Execute an A-Skill explicitly
  --agent <name>             Delegate explicitly: auto, codex, opencode, or pi
  --task-repo <path>         Add a task repository for this invocation
  --text <text>              Add a text payload
  --file <path>              Add a UTF-8 file payload
  --url <url>                Add an HTTP(S) UTF-8 payload
  --stdin                    Add standard input as payload
  --output <path>            Write the result to a file
  --force                    Permit overwriting the output file
  --interactive, -i          Start or retain an interactive session
  --model <value>            Override the model or model tag
  --tag <tag>                Add a model-selection tag
  --reasoning-effort <value> Override reasoning effort
  --model-config <path>      Override AchillesAgentLib model configuration
  --achilles-path <path>     Override AchillesAgentLib resolution
  --config <path>            Override the ALA configuration file
  Interactive: /symbolic detection on|off  Toggle symbolic routing in a session
  --help, -h                 Show help
  --version, -v              Show version`;
