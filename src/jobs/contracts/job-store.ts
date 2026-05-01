import type { Database } from 'better-sqlite3';

import type { AppendedEvent, CommitClosureResult, CommitContext } from '../../store/append.js';
import type { JobContinuitySnapshot } from '../continuity.js';
import type { JobProjectionDetail } from '../read-contract.js';
import type { JobEventBus } from '../event-bus.js';
import type { JobTerminalDiagnostics, JobLaunch, JobEvent, JobRuntime, JobStatus } from '../records.js';

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

export type TerminalWriteOptions = {
  continuity?: JobContinuitySnapshot | null;
  diagnostics?: JobTerminalDiagnostics;
};

export interface JobProgressStore {
  getEventBus(): JobEventBus;
  getDb(): Database;
  jobDir(jobId: string): string;
  getChangeSeq(): number;
  waitForChange(sinceSeq: number): Promise<void>;
  loadJobProjectionDetail(jobId: string): JobProjectionDetail;
  readJobEvents(jobId: string): JobEvent[];
  ensureResultArtifact(jobId: string): string;
  commit(cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult): AppendedEvent[];
  initJob(opts: InitJobOptions): void;
  rollbackJob(jobId: string): void;
  purgeFromCache(jobId: string): void;
  readStatus(jobId: string): JobStatus | null;
  nextEnqueueSequence(): number;
  appendLaunchRequested(jobId: string, launch: JobLaunch): void;
  readLaunchProjection(jobId: string): JobLaunch | null;
  appendRuntimeStarted(jobId: string, runtime: JobRuntime): void;
  readRuntimeProjection(jobId: string): JobRuntime | null;
  rebindNamespace(jobId: string, newNamespace: string, newBundleHash?: string): void;
  listJobIds(): string[];
  liveJobCountByNamespace(namespace: string): number;
  hydrateJobStartedAt(jobId: string, startTime: string): void;
  appendProgress(jobId: string, sessionId: string | null, message: string): number;
}
