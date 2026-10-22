import type { JobConversationFacet } from '../launch.js';
import type { JobLocationSubject } from '../location-index.js';
import type { RecoveryObservation } from '../../recovery/phase-observation.js';
import type { Database } from '../../store/db.js';

import type { AppendedEvent, CommitClosureResult, CommitContext } from '../../store/append.js';
import type { JobProjectionDetail } from '../read-queries.js';
import type { JobEventBus } from '../event-bus.js';
import type { JobTerminalDiagnostics, JobLaunch, JobEvent, JobRuntime, JobStatus, JobTerminal } from '../records.js';
import type { DurableCliProvisionalProcessRuntimeMeta } from '../runtime-meta.js';

type InitJobBase = {
  jobId: string;
  conversation: JobConversationFacet;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  initialPhase?: JobStatus['phase'];
};

export type InitJobOptions = InitJobBase & { jobKind?: 'provider' };

export type TerminalWriteOptions = {
  diagnostics?: JobTerminalDiagnostics;
};

export interface JobProgressStore {
  withExecutionAdmission(jobId: string, execution: number, subject: JobLocationSubject, action: () => void): void;
  getEventBus(): JobEventBus;
  getDb(): Database;
  jobDir(jobId: string): string;
  getChangeSeq(): number;
  waitForChange(sinceSeq: number): Promise<void>;
  loadJobProjectionDetail(jobId: string, observation?: RecoveryObservation): JobProjectionDetail;
  readJobEvents(
    jobId: string,
    terminalOnly?: boolean,
    afterSeq?: number,
    observation?: RecoveryObservation,
  ): JobEvent[];
  ensureResultArtifact(jobId: string, observation?: RecoveryObservation, execution?: number): string;
  commit(cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult): AppendedEvent[];
  initJob(opts: InitJobOptions): void;
  rollbackJob(jobId: string): void;
  purgeFromCache(jobId: string): void;
  readStatus(jobId: string): JobStatus | null;
  nextEnqueueSequence(): number;
  appendLaunchRequested(jobId: string, launch: JobLaunch): void;
  readLaunchProjection(jobId: string): JobLaunch | null;
  appendRuntimeStarted(
    jobId: string,
    runtime: JobRuntime,
    provisionalProcess?: Omit<DurableCliProvisionalProcessRuntimeMeta, 'jobId'>,
  ): void;
  readRuntimeProjection(jobId: string): JobRuntime | null;
  readTerminalProjection(jobId: string): JobTerminal | null;
  rebindNamespace(jobId: string, newNamespace: string, newBundleHash?: string): void;
  listJobIds(): string[];
  liveJobCount(): number;
  appendProgress(jobId: string, message: string): number;
}
