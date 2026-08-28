export const ALA_EVENT_PREFIX = '@@ALA_EVENT@@';

export function createRuntimeEventSink({ stream = process.stderr, env = process.env } = {}) {
  const streamEnabled = env.ALA_EVENT_STREAM === '1' || env.ALA_EVENT_STREAM === 'true';
  return (event) => {
    if (streamEnabled) stream.write(`${ALA_EVENT_PREFIX}${JSON.stringify(event)}\n`);
  };
}
