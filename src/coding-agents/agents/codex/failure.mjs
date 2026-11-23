import { reasonWords } from '../../failure-reason.mjs';

// Codex app-server TurnError.codexErrorInfo: a variant name such as "usageLimitExceeded", or an object with one
// variant key whose value may carry httpStatusCode.
export function codexFailure(turnError) {
  const info = turnError?.codexErrorInfo;
  if (typeof info === 'string' && info) return { agent: 'codex', code: info, reason: reasonWords(info) };
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const [code, detail] = Object.entries(info)[0] || [];
    if (!code) return null;
    const httpStatus = Number.isInteger(detail?.httpStatusCode) ? detail.httpStatusCode : null;
    return { agent: 'codex', code, reason: reasonWords(code), ...(httpStatus ? { httpStatus } : {}) };
  }
  return null;
}
