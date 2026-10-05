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
  | { version?: never; afterSeq: number; deliveredJobIds?: string[]; admittedJobIds?: string[] }
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
  drainProgress?: boolean;
  admissions?: WaitAdmission[];
  onLegacyCursor?: (cursor: Extract<WaitCursor, { afterSeq: number }>) => void;
  onCoverage?: (jobIds: readonly string[], unknownJobIds: readonly string[], frontier: number) => void;
}

export type CanonicalWaitStreamRequest = WaitStreamRequest & {
  supportsWaitV2: boolean;
  supportsWaitV3: boolean;
  supportsInterrupted: boolean;
  supportsHandover: boolean;
};

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
  | { type: 'notice'; version: 'jobs.wait.v3'; message: string; cursor?: WaitCursorV3; exitCode?: number }
  | {
      type: 'disposition';
      version: 'jobs.wait.v3';
      jobId: string;
      exitCode?: number;
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
      exitCode?: number;
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
      /** Unknown carrier IDs must be sorted, and empty coverage must omit this field. */
      carrierUnknownJobIds?: string[];
    };

/**
 * A handover notice may be sent only to a subscriber that declared `supportsHandover`; others would read the
 * following end as final.
 */
export type WaitHandoverNotice = { type: 'handover' };

/** Carrier absence cannot end a job, release its claim, or become a recorded interruption fault. */
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

export type WaitCarrierCoverage = {
  unknownJobIds: readonly string[];
  interrupted: readonly CarrierInterruptedWaitEvent[];
  frontier: number;
};

export interface JobWaitPort {
  readWaitAdmissions?(jobIds: readonly string[], epochKey: string, session?: object): WaitAdmission[];
  observeWaitCarriers?(jobIds: readonly string[], signal: AbortSignal): Promise<WaitCarrierCoverage>;
  readWaitAdmission?(jobId: string, epochKey: string, session?: object): WaitAdmission | null;
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
  waitForJobs(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitForOutcomes?(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult>;
}
