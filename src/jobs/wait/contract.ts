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
/** The one wait frontier shape: an entry per job and no version tag. Any other shape is refused, never translated. */
export type WaitCursor = Readonly<{ jobs: readonly WaitCursorEntry[] }>;

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
  onCoverage?: (jobIds: readonly string[], unknownJobIds: readonly string[], frontier: number) => void;
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
type Final = { cursor: WaitCursor; exitCode: number };
export type WaitStreamEvent =
  | { type: 'notice'; message: string }
  // The complete frontier for a cut before the final event: it replaces the client's base and never completes.
  | { type: 'cursor'; cursor: WaitCursor }
  | {
      type: 'disposition';
      jobId: string;
      disposition: Exclude<WaitAdmission['disposition'], 'admitted'>;
      message?: string;
    }
  | (Final & { type: 'artifact'; jobId: string; availability: ResultAvailability; remainingJobIds: string[] })
  | (ProgressWaitEvent & { entry: WaitCursorEntry })
  | (QueuedWaitEventBase & { jobKind: 'provider'; sessionId: string })
  | (QueuedWaitEventBase & { jobKind: 'workflow'; workflowId: string })
  | (QueuedWaitEventBase & { jobKind: 'kb'; systemTaskId: string })
  | (TerminalWaitEvent & Final & { availability: ResultAvailability; resultPath?: string; epochKey?: string })
  | CarrierInterruptedWaitEvent
  | (Final & { type: 'waiting'; waitingJobIds: string[]; carrierUnknownJobIds?: string[] });

export function isFinalWaitEvent(
  event: WaitStreamEvent,
): event is Extract<WaitStreamEvent, { type: 'terminal' | 'artifact' | 'waiting' }> {
  return event.type === 'terminal' || event.type === 'artifact' || event.type === 'waiting';
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
