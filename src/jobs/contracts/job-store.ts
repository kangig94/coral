import type { Database } from '../../store/db.js';

import type { AppendedEvent, CommitClosureResult, CommitContext } from '../../store/append.js';
import type { JobContinuitySnapshot } from '../continuity.js';
import type { JobProjectionDetail } from '../read-queries.js';
import type { JobEventBus } from '../event-bus.js';
import type { JobTerminalDiagnostics, JobLaunch, JobEvent, JobRuntime, JobStatus } from '../records.js';
import type { ProviderCredentialSet } from '../../runtime/provider-credentials.js';

type InitJobBase = {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  initialPhase?: JobStatus['phase'];
};

export type InitJobOptions = InitJobBase &
  (
    | { jobKind?: Exclude<JobStatus['jobKind'], 'workflow'> }
    | { jobKind: 'workflow'; providerCredentials: ProviderCredentialSet }
  );

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
  appendProgress(jobId: string, sessionId: string | null, message: string): number;
}
