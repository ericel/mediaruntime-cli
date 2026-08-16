const FRAMES = ["⣋", "⣙", "⣹", "⣸", "⣼", "⣴", "⣦", "⣧", "⣇", "⣏"];
const CLEAR_LINE = "\r\u001b[2K";

export interface ActivityIndicator {
  start(message: string): void;
  update(message: string): void;
  stop(): void;
}

export function createActivityIndicator(
  write: (text: string) => void,
  enabled: boolean,
): ActivityIndicator {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  let message = "";
  let startedAt = 0;

  const render = (): void => {
    if (!timer && startedAt === 0) return;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const elapsed = elapsedSeconds > 0 ? ` (${elapsedSeconds}s)` : "";
    write(`${CLEAR_LINE}${FRAMES[frameIndex % FRAMES.length]} ${message}${elapsed}`);
    frameIndex += 1;
  };

  return {
    start(nextMessage) {
      if (!enabled) return;
      if (timer) clearInterval(timer);
      message = nextMessage;
      startedAt = Date.now();
      frameIndex = 0;
      render();
      timer = setInterval(render, 80);
      timer.unref?.();
    },
    update(nextMessage) {
      if (!enabled || startedAt === 0) return;
      message = nextMessage;
      render();
    },
    stop() {
      if (!enabled || startedAt === 0) return;
      if (timer) clearInterval(timer);
      timer = undefined;
      startedAt = 0;
      write(CLEAR_LINE);
    },
  };
}
