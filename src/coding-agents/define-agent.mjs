// Validates one coding-agent descriptor when the registry loads, so a missing field fails at startup
// instead of surfacing later as a sandbox without state or credentials.
//
// Descriptor modules hold only data and pure functions. They must not import process or adapter code
// statically: the sandbox reads descriptors and adapters run on the sandbox.
//
//   name, label, description          identifier, display name, and the name used in help text
//   binary: { env, installPaths }     override variable and (home) => standard install locations
//   capabilities: { approvals, privateProc }
//   state(env, home)                  [{ source, target, login? }]; the login entry, or else the first one,
//                                     is the directory holding the stored login
//   homeEnvironment(root)             variables that place the agent's state under an explicit home (optional)
//   sandbox: { envAllow, envSet, credentialEnv, installMarker? }
//   login: { files, detect(directory) }
//   adapter()                         resolves to { run, runLive?, listModels }
const fail = (name, field) => {
  throw new TypeError(`Coding-agent descriptor ${name || '(unnamed)'} is missing ${field}.`);
};
const isFunction = (value) => typeof value === 'function';
const isText = (value) => typeof value === 'string' && value !== '';

export function defineAgent(descriptor) {
  const { name, label, description, binary, capabilities, state, sandbox, login, adapter } = descriptor;
  if (!/^[a-z][a-z0-9-]*$/u.test(name || '')) fail(name, 'a lowercase name');
  if (!isText(label)) fail(name, 'label');
  if (!isText(description)) fail(name, 'description');
  if (!isText(binary?.env)) fail(name, 'binary.env');
  if (!isFunction(binary?.installPaths)) fail(name, 'binary.installPaths');
  if (typeof capabilities?.approvals !== 'boolean') fail(name, 'capabilities.approvals');
  if (typeof capabilities?.privateProc !== 'boolean') fail(name, 'capabilities.privateProc');
  if (!isFunction(state)) fail(name, 'state');
  if (!Array.isArray(sandbox?.envAllow)) fail(name, 'sandbox.envAllow');
  if (!sandbox?.envSet || typeof sandbox.envSet !== 'object') fail(name, 'sandbox.envSet');
  if (!Array.isArray(sandbox?.credentialEnv)) fail(name, 'sandbox.credentialEnv');
  if (!Array.isArray(login?.files) || login.files.length === 0) fail(name, 'login.files');
  if (!isFunction(login?.detect)) fail(name, 'login.detect');
  if (!isFunction(adapter)) fail(name, 'adapter');
  return Object.freeze({ homeEnvironment: () => ({}), ...descriptor });
}
