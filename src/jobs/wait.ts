import type { JobTerminal } from './views.js';

export type WaitCursor = {
  jobs: Record<string, number>;
};

export interface WaitRequest {
  jobIds: string[];
  timeoutSeconds?: number;
  projectRoot?: string;
}

export interface WaitStreamRequest extends WaitRequest {
  cursor?: WaitCursor;
}

export type WaitStreamEvent =
  | { type: 'progress'; jobId: string; eventId: number; message: string }
  | {
      type: 'queued';
      jobId: string;
      sessionId: string;
      queuePosition: number;
      runningJobIds: string[];
    }
  | {
      type: 'terminal';
      jobId: string;
      remainingJobIds: string[];
      resultPath: string;
      result: JobTerminal;
    }
  | { type: 'waiting'; waitingJobIds: string[] };
