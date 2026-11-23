import { reasonWords, responseErrorType } from '../../failure-reason.mjs';

// OpenCode message and session errors: { name, data }. APIError carries the provider's HTTP status and response
// body, whose JSON error type (for example FreeUsageLimitError) names the cause.
export function openCodeFailure(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  if (name === 'APIError') {
    const httpStatus = Number.isInteger(data.statusCode) ? data.statusCode : null;
    const type = responseErrorType(data.responseBody);
    return { agent: 'opencode', code: type || 'api_error', reason: type ? reasonWords(type) : 'provider error',
      ...(httpStatus ? { httpStatus } : {}) };
  }
  if (name === 'ProviderAuthError') {
    return { agent: 'opencode', code: name, reason: `provider authentication failed${data.providerID ? ` (${data.providerID})` : ''}` };
  }
  if (['ContextOverflowError', 'MessageOutputLengthError', 'ContentFilterError'].includes(name)) {
    return { agent: 'opencode', code: name, reason: reasonWords(name.replace(/Error$/u, '')) };
  }
  return null;
}
