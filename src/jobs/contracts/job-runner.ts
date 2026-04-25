import type { ProviderRequest, ProviderSpec } from '../../providers/contract.js';
import type { SessionEntry } from '../../sessions/entry.js';
import type { TerminalWriteOptions } from './progress-store.js';
import type { JobPhase } from '../phase.js';
import type { LaunchDecision } from '../launch.js';
import type { JobLaunch, JobTerminalInput } from '../records.js';
import type { AbortReason } from '../outcome.js';
import type { AcceptedAdmission, LaunchPool, QueuedHandle } from './admission.js';
import type { ClaimJobOptions } from '../session-claim.js';

export interface ProviderJobLaunchPort {
  claimAndAdmitJob(
    session: SessionEntry,
    providerName: string,
    projectRoot: string,
    sessionBusyMessage: string,
    claimJobAtomic: (
      session: SessionEntry,
      jobId: string,
      providerName: string,
      projectRoot: string,
      options?: ClaimJobOptions,
    ) => Promise<SessionEntry>,
    expectedVersion?: number,
    pool?: LaunchPool,
    requestedJobId?: string,
  ): Promise<{ jobId: string; admission: AcceptedAdmission } | LaunchDecision>;

  launchProviderJob(
    provider: ProviderSpec,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    opts?: { pool?: LaunchPool; projectRoot?: string; parentWorkflowJobId?: string; workflowSlotId?: string },
  ): LaunchDecision;
}

export interface QueuedJobAbortPort {
  finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void;
}

export interface WorkflowJobLifecyclePort {
  markJobRunning(jobId: string): void;
  writeJobTerminal(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
}

export interface RecoveredJobLifecyclePort {
  runRecoveredQueuedJob(
    provider: ProviderSpec,
    launchRecord: JobLaunch,
    queuedHandle: QueuedHandle,
    pool: LaunchPool,
  ): void;
  writeJobTerminal(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
}
