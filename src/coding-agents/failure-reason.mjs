// The structured reason a coding agent gives for a failed turn, when it gives one. Each agent reads only fields its
// native protocol reports (never words in a message), so a reason is shown only when the agent states it. The reason
// is added to the error text, which is what callers display, and kept as `error.failure` for callers that read it.

const CAMEL_WORDS = /([a-z0-9])([A-Z])/gu;

export function reasonWords(value) {
  return String(value).replace(CAMEL_WORDS, '$1 $2').replace(/[_-]+/gu, ' ').toLowerCase().trim();
}

// Native reset times are Unix seconds or date strings; a number that large is already milliseconds.
export function isoTime(value) {
  const date = typeof value === 'number' && Number.isFinite(value) ? new Date(value < 1e12 ? value * 1000 : value)
    : typeof value === 'string' && value.trim() ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function failureText({ reason, httpStatus, resetsAt } = {}) {
  const parts = [reason, httpStatus ? `HTTP ${httpStatus}` : null, resetsAt ? `resets at ${resetsAt}` : null].filter(Boolean);
  return parts.length ? `reason: ${parts.join(', ')}` : '';
}

// An Error whose message carries the reason, or the message alone when there is none.
export function failureError(message, failure = null) {
  const text = failure ? failureText(failure) : '';
  const error = new Error(text ? `${message} [${text}]` : message);
  if (text) error.failure = failure;
  return error;
}

// The JSON error type of a provider response body, for example `{ "error": { "type": "FreeUsageLimitError" } }`.
export function responseErrorType(body) {
  if (typeof body !== 'string' || !body.trim() || body.length > 65536) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const candidates = [parsed?.error?.type, parsed?.error?.name, parsed?.type, parsed?.name, parsed?.error?.code];
  return candidates.find((value) => typeof value === 'string' && value !== 'error' && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/u.test(value)) || null;
}
