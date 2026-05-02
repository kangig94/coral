import type { TimePort } from './port-types.js';

type TimeNowPort = {
  now(): number;
};

export function nowDate(time: TimeNowPort): Date {
  return new Date(time.now());
}

export function nowIsoString(timeOrEpoch: TimeNowPort | number): string {
  const epochMs = typeof timeOrEpoch === 'number' ? timeOrEpoch : timeOrEpoch.now();
  return new Date(epochMs).toISOString();
}

export function createRealTimePort(): TimePort {
  return {
    now: () => Date.now(),
    sleep: (ms, options) =>
      new Promise<void>((resolve) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        timer.unref?.();
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      if (handle) clearTimeout(handle as NodeJS.Timeout);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => {
      if (handle) clearInterval(handle as NodeJS.Timeout);
    },
  };
}
