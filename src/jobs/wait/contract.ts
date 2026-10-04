import type { JobTerminal } from '../records.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { JobProgressTiming } from '../event-bodies.js';
import type { JobPhase } from '../phase.js';
import type { ResultAvailability } from '../terminal/export.js';
import type { WaitAdmission } from './session.js';
import type { UsageSummary } from '../../providers/contract.js';

export const WAIT_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;

export type WaitCursorV3 = {
  version: 'jobs.wait.v3';
  epochs: Array<{ token: string; watermark: number; lineOffset: number }>;
  jobs: Array<{ hash: string; epoch: number; flags: number }>;
};

export type WaitCursor =
  | WaitCursorV3
  | { version?: never; afterSeq: number; deliveredJobIds?: string[] }
  | {
      version: 'jobs.wait.v2';
      positions: Record<string, number>;
      locations: Record<string, string>;
      deliveredJobIds?: string[];
    };

export interface WaitRequest {
  jobIds: string[];
  timeoutSeconds?: number;
  projectRoot?: string;
}

export interface WaitStreamRequest extends WaitRequest {
  cursor?: WaitCursor;
  abortSignal?: AbortSignal;
  supportsWaitV2?: boolean;
  supportsWaitV3?: boolean;
  admissions?: WaitAdmission[];
  onCoverage?: (jobIds: readonly string[], unknownJobIds: readonly string[], frontier: number) => void;
}

export interface WaitSnapshotRequest extends WaitStreamRequest {
  lines?: number;
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
  | { type: 'notice'; version: 'jobs.wait.v3'; message: string; cursor?: WaitCursorV3 }
  | {
      type: 'disposition';
      version: 'jobs.wait.v3';
      jobId: string;
      disposition: Exclude<WaitAdmission['disposition'], 'admitted'>;
      message?: string;
      cursor?: WaitCursorV3;
    }
  | {
      type: 'artifact';
      version: 'jobs.wait.v3';
      jobId: string;
      availability: ResultAvailability;
      remainingJobIds: string[];
      cursor: WaitCursorV3;
      exitCode: number;
    }
  | {
      type: 'progress';
      jobId: string;
      seq: number;
      message: string;
      timing: JobProgressTiming;
      version?: 'jobs.wait.v2' | 'jobs.wait.v3';
      epochKey?: string;
      cursor?: Exclude<WaitCursor, { afterSeq: number }>;
    }
  | (QueuedWaitEventBase & {
      jobKind: 'provider';
      sessionId: string;
      cursor?: Exclude<WaitCursor, { afterSeq: number }>;
    })
  | (QueuedWaitEventBase & {
      jobKind: 'workflow';
      workflowId: string;
      cursor?: Exclude<WaitCursor, { afterSeq: number }>;
    })
  | (QueuedWaitEventBase & {
      jobKind: 'kb';
      systemTaskId: string;
      cursor?: Exclude<WaitCursor, { afterSeq: number }>;
    })
  | {
      type: 'terminal';
      jobId: string;
      seq: number;
      remainingJobIds: string[];
      resultPath?: string;
      availability?: ResultAvailability;
      exitCode?: number;
      result: JobTerminal;
      version?: 'jobs.wait.v2' | 'jobs.wait.v3';
      continuity?: ContinuitySnapshot | null;
      usage?: UsageSummary;
      epochKey?: string;
      cursor?: Exclude<WaitCursor, { afterSeq: number }>;
    }
  | CarrierInterruptedWaitEvent
  | {
      type: 'waiting';
      waitingJobIds: string[];
      version?: 'jobs.wait.v3';
      exitCode?: number;
      cursor?: Exclude<WaitCursor, { afterSeq: number }>;
      /** Sorted; omitted entirely when empty, so "nothing unknown" costs no wire field. */
      carrierUnknownJobIds?: string[];
    };

/**
 * A handover notice may be sent only to a subscriber that declared `supportsHandover`; others would read the
 * following end as final.
 */
export type WaitHandoverNotice = { type: 'handover' };

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
  version?: 'jobs.wait.v3';
  jobId: string;
  storedPhase: JobPhase;
  observedMaxJournalSeq: number;
  remainingJobIds: string[];
  observation: { kind: 'carrier_interrupted'; reason: 'carrier_absent' };
  continuity: 'unavailable';
  outcome: 'unknown';
  cursor?: Exclude<WaitCursor, { afterSeq: number }>;
};

/**
 * Coordinator-facing wait surface that the jobs domain exposes. Defined here
 * (next to the WaitStream value types) so the port and the values it carries
 * stay in one place — splitting the interface into a separate `wait-port.ts`
 * was over-decomposition.
 */
export interface JobWaitPort {
  readWaitAdmission?(jobId: string, epochKey: string): WaitAdmission | null;
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
  waitForJobs(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult>;
}
