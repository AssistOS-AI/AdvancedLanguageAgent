import { ALAError, EXIT_CODES } from './errors.mjs';
import { validatePermissionMode } from './permission-requests.mjs';

export function createPermissionCommand(runtime, initialMode = 'full-access') {
  let mode = validatePermissionMode(initialMode);
  return (parts) => {
    if (parts.length > 2 || (parts.length === 2
      && !['ask-for-approval', 'full-access'].includes(parts[1]))) {
      throw new ALAError('Usage: /permissions [ask-for-approval|full-access]', EXIT_CODES.usage);
    }
    if (parts.length === 1) return `Native permissions: ${mode}`;
    const next = validatePermissionMode(parts[1]);
    runtime.setPermissionMode(next);
    mode = next;
    return `Native permissions: ${mode}. Applies to subsequent executions in this session; backend constraints remain authoritative.`;
  };
}
