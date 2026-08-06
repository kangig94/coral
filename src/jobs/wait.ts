import type { JobTerminal } from './records.js';
import type { ContinuitySnapshot } from '../sessions/continuity.js';
import type { JobProgressTiming } from './event-bodies.js';
import type { JobPhase } from './phase.js';
import type { UsageSummary } from '../providers/contract.js';

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
  continuity: ContinuitySnapshot | null;
};

type QueuedWaitEventBase = {
  type: 'queued';
  jobId: string;
  queuePosition: number;
  runningJobIds: string[];
  timing: JobProgressTiming;
};

export type WaitStreamEvent =
  | { type: 'progress'; jobId: string; seq: number; message: string; timing: JobProgressTiming }
  | (QueuedWaitEventBase & { jobKind: 'provider'; sessionId: string })
  | (QueuedWaitEventBase & { jobKind: 'workflow'; workflowId: string })
  | (QueuedWaitEventBase & { jobKind: 'kb'; systemTaskId: string })
  | {
      type: 'terminal';
      jobId: string;
      seq: number;
      remainingJobIds: string[];
      resultPath: string;
      result: JobTerminal;
      continuity?: ContinuitySnapshot | null;
      usage?: UsageSummary;
    }
  | CarrierInterruptedWaitEvent
  | {
      type: 'waiting';
      waitingJobIds: string[];
      /** Sorted; omitted entirely when empty, so "nothing unknown" costs no wire field. */
      carrierUnknownJobIds?: string[];
    };

/**
 * The wire-only report that a job's carrier was observed absent.
 *
 * Deliberately nonterminal, and deliberately missing everything a terminal has: no journal `seq`, no
 * `result`, no `resultPath`, no continuity snapshot, and no session release. Derived absence may tell a
 * waiting human what it sees; it may not end the job, free its claim, or become a stored
 * `SessionInterruptedFault`. The subscription stays open and the exit code stays pending, because the
 * journal terminal is still the only thing that decides either — and if one arrives after this, it wins.
 */
export type CarrierInterruptedWaitEvent = {
  type: 'interrupted';
  jobId: string;
  storedPhase: JobPhase;
  observedMaxJournalSeq: number;
  remainingJobIds: string[];
  observation: { kind: 'carrier_interrupted'; reason: 'carrier_absent' };
  continuity: 'unavailable';
  outcome: 'unknown';
};

/**
 * Coordinator-facing wait surface that the jobs domain exposes. Defined here
 * (next to the WaitStream value types) so the port and the values it carries
 * stay in one place — splitting the interface into a separate `wait-port.ts`
 * was over-decomposition.
 */
export interface JobWaitPort {
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
  waitForJobs(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult>;
}
