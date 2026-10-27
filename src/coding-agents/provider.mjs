import { ALAError, EXIT_CODES } from '../errors.mjs';

// The execution-provider contract. ALA describes every native process it needs and a provider either satisfies
// the request or refuses it; process creation exists only inside provider implementations. This module holds the
// constants, the request vocabulary and the shape check shared by every provider. The versioned wire protocol is
// specified in DS006 and implemented by provider-client.mjs.

export const PROVIDER_PROTOCOL = 'ala-execution-provider';
export const PROVIDER_PROTOCOL_VERSION = 1;
export const PROVIDER_NAMES = Object.freeze(['bubblewrap', 'protocol']);
export const PROCESS_CLASSES = Object.freeze(['run', 'session', 'service']);
export const NETWORK_MODES = Object.freeze(['robot-egress', 'none']);
export const ROBOT_HOME = '/home/robot';
export const DEFAULT_STOP_GRACE_MS = 2000;
export const SERVICE_READY_TIMEOUT_MS = 30_000;
const MESSAGE_LIMIT = 512;

export function providerError(message, options) {
  return new ALAError(message, EXIT_CODES.execution, options);
}

// A provider message is untrusted text: strip control characters and bound its length before it reaches a user.
export function providerText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, MESSAGE_LIMIT);
}

// A provider is any object with a name-like kind and a start function. The CLI constructs only the Bubblewrap and
// protocol providers (selectExecutionProvider); other objects are reachable only from tests that inject them.
export function isProvider(value) {
  return Boolean(value) && typeof value.kind === 'string' && value.kind !== '' && typeof value.start === 'function';
}

export function requireProvider(sandbox) {
  const provider = sandbox?.provider;
  if (!isProvider(provider)) {
    throw providerError('Coding-agent processes require an execution provider.');
  }
  return provider;
}

export function requireProcessClass(processClass) {
  if (!PROCESS_CLASSES.includes(processClass)) {
    throw providerError(`Unknown execution-provider process class: ${providerText(processClass)}`);
  }
  return processClass;
}
