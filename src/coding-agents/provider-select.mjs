import { ALAError, EXIT_CODES } from '../errors.mjs';
import { createBubblewrapProvider } from './provider-bubblewrap.mjs';
import { createProtocolProvider } from './provider-client.mjs';
import { PROVIDER_NAMES } from './provider.mjs';

export const PROVIDER_OPTION = '--execution-provider';
export const PROVIDER_ENVIRONMENT = 'ALA_EXECUTION_PROVIDER';

// Validates a provider name from the option or the environment value. Nothing is inferred: a name outside the
// supported set is a usage error, and a name that is present but empty is not treated as unset.
export function parseProviderName(value, source) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !PROVIDER_NAMES.includes(value)) {
    throw new ALAError(`${source} must be ${PROVIDER_NAMES.join(' or ')}.`, EXIT_CODES.usage);
  }
  return value;
}

// The embedding service selects the provider explicitly, by `--execution-provider` or ALA_EXECUTION_PROVIDER (the
// option wins). There is no auto-detection: the presence of a control channel selects nothing, and without a
// selection the standalone Bubblewrap provider is the default. Selecting `protocol` never falls back, and it never
// constructs the Bubblewrap provider, so embedded mode never probes Bubblewrap.
export function resolveProviderName({ name = null, env = process.env } = {}) {
  return parseProviderName(name, PROVIDER_OPTION)
    ?? parseProviderName(env[PROVIDER_ENVIRONMENT], PROVIDER_ENVIRONMENT) ?? 'bubblewrap';
}

export function selectExecutionProvider({ name = null, env = process.env, channel = process, dependencies = {} } = {}) {
  const selected = resolveProviderName({ name, env });
  if (selected === 'protocol') return (dependencies.createProtocolProvider || createProtocolProvider)({ channel, baseEnv: env });
  return (dependencies.createBubblewrapProvider || createBubblewrapProvider)();
}
