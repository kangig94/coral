type TimeoutHandle = {
  unref?(): void;
};

type TimeoutPort = {
  setTimeout(fn: () => void, ms: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle | null): void;
};

export function raceTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  time?: TimeoutPort,
): Promise<boolean> {
  const timers = time ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout> | null) => {
      if (handle) {
        clearTimeout(handle);
      }
    },
  };

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const timer = timers.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        timers.clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        timers.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
