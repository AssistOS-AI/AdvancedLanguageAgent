import { validatePermissionMode } from '../../../permission-requests.mjs';

export const OPENCODE_V2_SUPPORTED = true;

export function openCodeV2Rules(mode = 'full-access', websearch = true) {
  validatePermissionMode(mode);
  return [
    { action: '*', resource: '*', effect: mode === 'full-access' ? 'allow' : 'ask' },
    ...(!websearch ? ['websearch', 'webfetch'] : []).map(action => ({ action, resource: '*', effect: 'deny' })),
    ...['question', 'plan_enter', 'plan_exit'].map(action => ({ action, resource: '*', effect: 'deny' }))
  ];
}

export function openCodeV2Environment(env, websearch, servers = []) {
  const overlay = JSON.parse(env?.OPENCODE_CONFIG_CONTENT || '{}');
  if (!overlay || Array.isArray(overlay) || typeof overlay !== 'object') {
    throw new Error('OPENCODE_CONFIG_CONTENT must contain a JSON object.');
  }
  // Keep the caller's legacy config intact; V2 normalizes it. Only add run-local servers.
  const mcp = { ...overlay.mcp, servers: { ...overlay.mcp?.servers } };
  for (const server of servers) mcp.servers[server.name] = { type: 'remote', url: server.url, oauth: false };
  return { ...env, OPENCODE_ENABLE_EXA: websearch ? '1' : '0',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...overlay, update: 'disable', mcp }) };
}

export function requireOpenCodeV2Api(document) {
  for (const [path, method] of [
    ['/api/info', 'get'], ['/api/event', 'get'], ['/api/session', 'post'],
    ['/api/session/{sessionID}', 'get'], ['/api/session/{sessionID}', 'patch'],
    ['/api/session/{sessionID}/prompt', 'post'], ['/api/session/{sessionID}/message', 'get'],
    ['/api/session/{sessionID}/interrupt', 'post'], ['/api/session/{sessionID}/model', 'post'],
    ['/api/permission/request', 'get'], ['/api/session/{sessionID}/permission/{requestID}/reply', 'post']
  ]) {
    if (!document?.paths?.[path]?.[method]) throw new Error('Unsupported OpenCode V2 server API.');
  }
}

export function openCodeV2Model(value, effort) {
  const separator = value.indexOf('/');
  if (separator < 1 || separator === value.length - 1) throw new Error('OpenCode model must use provider/model format.');
  const [id, variant] = value.slice(separator + 1).split('#');
  return { providerID: value.slice(0, separator), id, ...(effort || variant ? { variant: effort || variant } : {}) };
}

export function openCodeV2Models(catalog) {
  if (!Array.isArray(catalog?.data)) throw new Error('Invalid OpenCode V2 model catalog.');
  return catalog.data.filter(model => model.enabled !== false).map(model => ({
    id: `${model.providerID}/${model.id}`, label: model.name || model.id,
    efforts: (model.variants || []).map(variant => variant.id)
  }));
}
