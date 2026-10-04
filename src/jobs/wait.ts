import type { JobTerminal } from './records.js';
import type { ContinuitySnapshot } from '../sessions/continuity.js';
import type { JobProgressTiming } from './event-bodies.js';
import type { JobPhase } from './phase.js';
import type { UsageSummary } from '../providers/contract.js';

export { decodeWaitCursor, decodeSerializedWaitCursor } from './wait-cursor.js';

export const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;

export type WaitCursor =
  | { version?: never; afterSeq: number; deliveredJobIds?: string[] }
  | {
      version: 'jobs.wait.v2';
      positions: Record<string, number>;
      locations: Record<string, string>;
      deliveredJobIds?: string[];
    };

export function serializeWaitCursor(cursor: WaitCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function waitCursorForJobs(cursor: WaitCursor, jobIds: readonly string[]): WaitCursor {
  const deliveredJobIds = cursor.deliveredJobIds?.filter((id) => jobIds.includes(id));
  if (cursor.version === undefined) return { ...cursor, ...(deliveredJobIds === undefined ? {} : { deliveredJobIds }) };
  const locations = Object.fromEntries(
    jobIds.flatMap((jobId) => {
      const epochKey = cursor.locations[jobId];
      return epochKey === undefined ? [] : [[jobId, epochKey]];
    }),
  );
  const requestedEpochs = new Set(Object.values(locations));
  const positions = Object.fromEntries(
    Object.entries(cursor.positions).filter(([epochKey]) => requestedEpochs.has(epochKey)),
  );
  return {
    version: 'jobs.wait.v2',
    locations,
    positions,
    ...(cursor.deliveredJobIds === undefined ? {} : { deliveredJobIds }),
  };
}

export interface WaitRequest {
  jobIds: string[];
  timeoutSeconds?: number;
  projectRoot?: string;
}

export interface WaitStreamRequest extends WaitRequest {
  cursor?: WaitCursor;
  abortSignal?: AbortSignal;
  supportsWaitV2?: boolean;
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
  | {
      type: 'progress';
      jobId: string;
      seq: number;
      message: string;
      timing: JobProgressTiming;
      version?: 'jobs.wait.v2';
      epochKey?: string;
      cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
    }
  | (QueuedWaitEventBase & {
      jobKind: 'provider';
      sessionId: string;
      cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
    })
  | (QueuedWaitEventBase & {
      jobKind: 'workflow';
      workflowId: string;
      cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
    })
  | (QueuedWaitEventBase & {
      jobKind: 'kb';
      systemTaskId: string;
      cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
    })
  | {
      type: 'terminal';
      jobId: string;
      seq: number;
      remainingJobIds: string[];
      resultPath: string;
      result: JobTerminal;
      version?: 'jobs.wait.v2';
      continuity?: ContinuitySnapshot | null;
      usage?: UsageSummary;
      epochKey?: string;
      cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
    }
  | CarrierInterruptedWaitEvent
  | {
      type: 'waiting';
      waitingJobIds: string[];
      cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
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
  jobId: string;
  storedPhase: JobPhase;
  observedMaxJournalSeq: number;
  remainingJobIds: string[];
  observation: { kind: 'carrier_interrupted'; reason: 'carrier_absent' };
  continuity: 'unavailable';
  outcome: 'unknown';
  cursor?: Extract<WaitCursor, { version: 'jobs.wait.v2' }>;
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
