const clearLine = '\r\u001b[2K';
const frames = Object.freeze(['Thinking.', 'Thinking..', 'Thinking...']);

export function createThinkingIndicator(stream, {
  enabled = Boolean(stream?.isTTY),
  intervalMs = 350,
  schedule = setInterval,
  cancel = clearInterval
} = {}) {
  let active = false;
  let frameIndex = 0;
  let timer = null;

  const render = () => {
    stream.write(`${clearLine}${frames[frameIndex]}`);
    frameIndex = (frameIndex + 1) % frames.length;
  };

  return {
    start() {
      if (!enabled || active) return;
      active = true;
      frameIndex = 0;
      render();
      timer = schedule(render, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (!active) return;
      active = false;
      if (timer !== null) cancel(timer);
      timer = null;
      stream.write(clearLine);
    },
    async run(operation) {
      this.start();
      try {
        return await operation();
      } finally {
        this.stop();
      }
    }
  };
}
