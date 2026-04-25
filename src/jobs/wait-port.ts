import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from './wait.js';

export interface JobWaitPort {
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
  waitForJobs(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult>;
}
