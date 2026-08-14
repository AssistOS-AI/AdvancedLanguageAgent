export const EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  input: 3,
  repository: 4,
  execution: 5,
  interrupted: 130
});

export class ALAError extends Error {
  constructor(message, exitCode, options = {}) {
    super(message, options);
    this.name = 'ALAError';
    this.exitCode = exitCode;
  }
}

export function asALAError(error) {
  if (error instanceof ALAError) return error;
  if (error?.name === 'AbortError') {
    return new ALAError('Execution interrupted.', EXIT_CODES.interrupted, { cause: error });
  }
  return new ALAError(error?.message || String(error), EXIT_CODES.execution, { cause: error });
}
