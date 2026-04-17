import type { TerminalResult } from '../shared/types.js';

/** CLI NDJSON unified event stream — all events share the `type` discriminator. */
export type CliStreamEvent =
  | { type: 'launch'; jobId: string; sessionId: string; status: 'running' | 'queued' }
  | { type: 'progress'; jobId: string; sessionId: string; message: string }
  | { type: 'queued'; jobId: string; sessionId: string; queuePosition: number; runningJobIds: string[] }
  | {
      type: 'terminal';
      jobId: string;
      sessionId: string;
      remainingJobIds: string[];
      result: Omit<TerminalResult, 'content'> & { path: string };
    }
  | { type: 'running'; runningJobIds: string[] };
