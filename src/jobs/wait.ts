import type { JobTerminal } from './records.js';
import type { JobContinuitySnapshot } from './continuity.js';

export const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;

export type WaitCursor = {
  afterSeq: number;
};

export function isWaitCursor(value: unknown): value is WaitCursor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const afterSeq = (value as { afterSeq?: unknown }).afterSeq;
  return Number.isInteger(afterSeq) && (afterSeq as number) >= 0;
}

export function parseSerializedWaitCursor(raw: string | undefined): WaitCursor | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as unknown;
    return isWaitCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeWaitCursor(cursor: WaitCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export interface WaitRequest {
  jobIds: string[];
  timeoutSeconds?: number;
  projectRoot?: string;
}

export interface WaitStreamRequest extends WaitRequest {
  cursor?: WaitCursor;
  abortSignal?: AbortSignal;
}

export type WaitStreamOnceResult = {
  content: string;
  continuity: JobContinuitySnapshot | null;
};

export type WaitStreamEvent =
  | { type: 'progress'; jobId: string; seq: number; message: string }
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
      seq: number;
      remainingJobIds: string[];
      resultPath: string;
      result: JobTerminal;
      continuity?: JobContinuitySnapshot | null;
    }
  | { type: 'waiting'; waitingJobIds: string[] };
