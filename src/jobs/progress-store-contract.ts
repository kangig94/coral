import type { Database } from 'better-sqlite3';

import type { AppendedEvent } from '../store/append.js';
import type { CoralEventInput } from '../store/envelope.js';
import type { JobContinuitySnapshot } from './continuity.js';
import type { JobPhase } from './phase.js';
import type { JobProjectionDetail } from './read-contracts.js';
import type { JobEventBus } from './event-bus.js';
import type {
  JobTerminalDiagnostics,
  JobTerminalInput,
  JobLaunch,
  JobProgress,
  JobRuntime,
  JobStatus,
  LaunchState,
} from './records.js';

export type InitJobOptions = {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: JobStatus['jobKind'];
  initialPhase?: JobStatus['phase'];
};

export type ReplayCursor = {
  lastEventId: number;
};

export type TerminalWriteOptions = {
  continuity?: JobContinuitySnapshot | null;
  diagnostics?: JobTerminalDiagnostics;
  exitCode?: number | null;
  signal?: string | null;
};

export interface JobProgressStore {
  getEventBus(): JobEventBus;
  getDb(): Database;
  jobDir(jobId: string): string;
  resultPath(jobId: string): string;
  getChangeSeq(): number;
  waitForChange(sinceSeq: number): Promise<void>;
  loadJobProjectionDetail(jobId: string): JobProjectionDetail;
  readJobProgress(jobId: string): JobProgress[];
  appendEventsWithResult(inputs: readonly CoralEventInput[]): AppendedEvent[];
  appendEvent(input: CoralEventInput): void;
  initJob(opts: InitJobOptions): void;
  rollbackJob(jobId: string): void;
  purgeFromCache(jobId: string): void;
  readStatus(jobId: string): JobStatus | null;
  updatePhase(jobId: string, phase: JobPhase): void;
  updateLaunchState(jobId: string, state: LaunchState, message?: string): void;
  writeResultMd(jobId: string, text: string): void;
  writeWorkflowResultMdOrThrow(jobId: string, text: string): void;
  nextEnqueueSequence(): number;
  writeLaunchRecord(jobId: string, record: JobLaunch): void;
  readLaunchRecord(jobId: string): JobLaunch | null;
  writeRuntimeRecord(jobId: string, record: JobRuntime): void;
  readRuntimeRecord(jobId: string): JobRuntime | null;
  rebindNamespace(jobId: string, newNamespace: string, newBundleHash?: string): void;
  listJobIds(): string[];
  liveJobCountByNamespace(namespace: string): number;
  hydrateEventCounter(jobId: string): void;
  hydrateJobStartedAt(jobId: string, startTime: string): void;
  appendProgress(jobId: string, sessionId: string, message: string): number;
  appendTerminal(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): number;
  markTerminalStatus(
    jobId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
  replayFrom(jobId: string, fromEventId: number, cursor: ReplayCursor): JobProgress[];
}
