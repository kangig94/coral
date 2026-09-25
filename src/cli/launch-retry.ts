import { IpcRpcError } from '../transport/ipc/client.js';

const PAUSE_RETRY_INTERVAL_MS = 100;

export async function retrySuccessionPausedLaunch<TResult>(
  issue: (remainingMs: number) => Promise<TResult>,
  budgetMs: number,
): Promise<TResult> {
  const deadline = performance.now() + budgetMs;
  let pauseError: IpcRpcError | null = null;
  for (;;) {
    const remainingMs = deadline - performance.now();
    if (pauseError !== null && remainingMs <= 0) throw pauseError;
    try {
      return await issue(Math.max(1, remainingMs));
    } catch (error: unknown) {
      if (!(error instanceof IpcRpcError) || error.code !== 'succession_admission_paused') throw error;
      pauseError = error;
      const retryAfterMs = deadline - performance.now();
      if (retryAfterMs <= 0) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(PAUSE_RETRY_INTERVAL_MS, retryAfterMs)));
    }
  }
}
