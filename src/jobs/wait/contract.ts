import type { SourceReadDisposition } from './session.js';
import type { ProgressPage, TailPage } from './progress-page.js';
import type { JobTerminal } from '../records.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { JobProgressTiming } from '../event-bodies.js';
import type { JobPhase } from '../phase.js';
import type { ResultAvailability } from '../terminal/export.js';
import type { WaitAdmission } from './session.js';
import type { UsageSummary } from '../../providers/contract.js';

export const WAIT_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;

export type WaitCursorEntry = Readonly<{
  hash: string;
  epoch: string | null;
  seq: number;
  lineOffset: number;
  flags: number;
}>;
export type WaitCursorV3 = Readonly<{ version: 'jobs.wait.v3'; jobs: readonly WaitCursorEntry[] }>;

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

type ProgressWaitEvent = {
  type: 'progress';
  jobId: string;
  seq: number;
  message: string;
  timing: JobProgressTiming;
};
type TerminalWaitEvent = {
  type: 'terminal';
  jobId: string;
  seq: number;
  remainingJobIds: string[];
  result: JobTerminal;
  continuity?: ContinuitySnapshot | null;
  usage?: UsageSummary;
};
type FinalV3 = { version: 'jobs.wait.v3'; cursor: WaitCursorV3; exitCode: number };
type LegacyCursor = {
  version?: 'jobs.wait.v2';
  epochKey?: string;
  cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
};
export type WaitStreamEvent =
  | { type: 'notice'; version: 'jobs.wait.v3'; message: string }
  | {
      type: 'disposition';
      version: 'jobs.wait.v3';
      jobId: string;
      disposition: Exclude<WaitAdmission['disposition'], 'admitted'>;
      message?: string;
    }
  | (FinalV3 & { type: 'artifact'; jobId: string; availability: ResultAvailability; remainingJobIds: string[] })
  | (ProgressWaitEvent & { version: 'jobs.wait.v3'; entry: WaitCursorEntry })
  | (ProgressWaitEvent & LegacyCursor)
  | (QueuedWaitEventBase & { jobKind: 'provider'; sessionId: string })
  | (QueuedWaitEventBase & { jobKind: 'workflow'; workflowId: string })
  | (QueuedWaitEventBase & { jobKind: 'kb'; systemTaskId: string })
  | (TerminalWaitEvent & FinalV3 & { availability: ResultAvailability; resultPath?: string; epochKey?: string })
  | (TerminalWaitEvent & LegacyCursor & { resultPath: string; availability?: never; exitCode?: never })
  | CarrierInterruptedWaitEvent
  | (FinalV3 & { type: 'waiting'; waitingJobIds: string[]; carrierUnknownJobIds?: string[] })
  | {
      type: 'waiting';
      waitingJobIds: string[];
      version?: never;
      exitCode?: never;
      cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
      carrierUnknownJobIds?: string[];
    };

export function isFinalWaitEvent(
  event: WaitStreamEvent,
): event is Extract<WaitStreamEvent, { type: 'terminal' | 'artifact' | 'waiting' }> {
  return event.type === 'terminal' || event.type === 'artifact' || event.type === 'waiting';
}

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
};

export type WaitCarrierCoverage = {
  unknownJobIds: readonly string[];
  interrupted: readonly CarrierInterruptedWaitEvent[];
  frontier: number;
};

export interface JobWaitPort {
  visitProgress?: ProgressVisit;
  readWaitAdmissions?(jobIds: readonly string[], epochKey: string, session?: object): WaitAdmission[];
  observeWaitCarriers?(jobIds: readonly string[], signal: AbortSignal): Promise<WaitCarrierCoverage>;
  readWaitAdmission?(jobId: string, epochKey: string, session?: object): WaitAdmission | null;
  waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void>;
  waitForJobs(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitForOutcomes?(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult>;
}

export interface ProgressSource {
  after(jobId: string, afterSeq: number, rows: number): ProgressPage;
  before(jobId: string, beforeSeq: number | null, rows: number): TailPage;
}
export type ProgressVisitResult<T> =
  | { kind: 'read'; value: T }
  | { kind: 'unreadable'; disposition: Exclude<SourceReadDisposition, 'readable'>; reason?: string };
export type ProgressVisit = <T>(epochKey: string, read: (source: ProgressSource) => T) => ProgressVisitResult<T>;
