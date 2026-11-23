import { isoTime, reasonWords } from '../../failure-reason.mjs';

// Claude Code reports its plan limits in rate_limit_event records; a rejected one is the reason a turn stopped.
// The result record of a failed request may carry the HTTP status as api_error_status.
export function createClaudeFailureTracker() {
  let rejected = null;
  let httpStatus = null;
  return {
    push(record) {
      if (record?.type === 'rate_limit_event') {
        const info = record.rate_limit_info || {};
        rejected = info.status === 'rejected' ? info : null;
      } else if (record?.type === 'result' && Number.isInteger(record.api_error_status)) {
        httpStatus = record.api_error_status;
      }
    },
    failure() {
      if (rejected) {
        const type = typeof rejected.rateLimitType === 'string' ? ` (${reasonWords(rejected.rateLimitType)})` : '';
        const resetsAt = isoTime(rejected.resetsAt);
        return { agent: 'claude', code: 'usage_limit', reason: `usage limit reached${type}`,
          ...(httpStatus ? { httpStatus } : {}), ...(resetsAt ? { resetsAt } : {}) };
      }
      return httpStatus ? { agent: 'claude', code: 'api_error', reason: 'provider error', httpStatus } : null;
    }
  };
}
