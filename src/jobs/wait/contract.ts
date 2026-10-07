import type { SourceReadDisposition } from '../source-read.js';
import type { JobTerminal } from '../records.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { JobProgressTiming } from '../event-bodies.js';
import type { JobPhase } from '../phase.js';
import type { ResultAvailability } from '../terminal/export.js';
import type { WaitAdmission } from './session.js';
import type { UsageSummary } from '../../providers/contract.js';

export const WAIT_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** The progress budget one bounded request, one snapshot, or one unbounded poll delivers at most. */
export const WAIT_PROGRESS_LINES = 500;
export const WAIT_PROGRESS_BYTES = 64 * 1024;

export const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;

/** The one wait frontier shape: the watermark seq in canonical decimal. Any other shape is refused. */
export type WaitCursor = string;

export interface WaitRequest {
  jobIds: string[];
  timeoutSeconds?: number;
  projectRoot?: string;
}

export interface WaitStreamRequest extends WaitRequest {
  cursor?: WaitCursor;
  abortSignal?: AbortSignal;
  drainProgress?: boolean;
  admissions?: WaitAdmission[];
}

export type CanonicalWaitStreamRequest = WaitStreamRequest & { drainProgress: boolean };

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
/** A null cursor resumes as a fresh collection. */
type Final = { cursor: WaitCursor | null; exitCode: number };
type TerminalBlock = TerminalWaitEvent & { availability: ResultAvailability; resultPath?: string; epochKey?: string };
export type WaitStreamEvent =
  | { type: 'notice'; message: string }
  // The frontier for a cut before the final event: it replaces the client's cursor and never completes.
  | { type: 'cursor'; cursor: WaitCursor }
  | {
      type: 'disposition';
      jobId: string;
      disposition: Exclude<WaitAdmission['disposition'], 'admitted'>;
      message?: string;
    }
  | ProgressWaitEvent
  | (QueuedWaitEventBase & { jobKind: 'provider'; sessionId: string })
  | (QueuedWaitEventBase & { jobKind: 'workflow'; workflowId: string })
  | (QueuedWaitEventBase & { jobKind: 'kb'; systemTaskId: string })
  // A terminal at or below the request's watermark carries no final fields: it is printed and ends nothing.
  | (TerminalBlock & Final)
  | TerminalBlock
  | CarrierInterruptedWaitEvent
  | (Final & { type: 'waiting'; waitingJobIds: string[]; carrierUnknownJobIds?: string[] });

export function isFinalWaitEvent(event: WaitStreamEvent): event is Extract<WaitStreamEvent, Final> {
  return 'exitCode' in event && event.exitCode !== undefined;
}

/** A handover notice tells the subscriber the clean end that follows is not final; it reconnects to the successor. */
export type WaitHandoverNotice = { type: 'handover' };

/** Carrier absence cannot end a job, release its claim, or become a recorded interruption fault. */
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
  waitForOutcomes(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult>;
}

/** A progress row without a message is a fault row: a reader skips it in order, past it like any consumed row. */
export type WaitProgressRow = Readonly<{ seq: number; message?: string; timing?: JobProgressTiming }>;

export interface ProgressSource {
  /** The journal frontier captured before any rows are read; every returned row has seq at or below it. */
  frontier(): number;
  /** The job's rows after `afterSeq`, oldest first, at most `rows` of them. */
  after(jobId: string, afterSeq: number, rows: number): readonly WaitProgressRow[];
  /** The job's newest `rows` rows, oldest first. */
  newest(jobId: string, rows: number): readonly WaitProgressRow[];
}
export type ProgressVisitResult<T> =
  | { kind: 'read'; value: T }
  | { kind: 'unreadable'; disposition: Exclude<SourceReadDisposition, 'readable'>; reason?: string };
export type ProgressVisit = <T>(epochKey: string, read: (source: ProgressSource) => T) => ProgressVisitResult<T>;
