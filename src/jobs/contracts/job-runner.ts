import type { ProviderRequest } from '../../providers/contract.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import type { RetentionPolicy, ProviderSession } from '../../sessions/entry.js';
import type { TerminalWriteOptions } from './job-store.js';
import type { JobPhase } from '../phase.js';
import type { ProviderSessionLaunchDecision } from '../launch.js';
import type { JobLaunch, JobTerminalInput } from '../records.js';
import type { AbortReason } from '../outcome.js';
import type { LaunchPool, QueuedHandle } from './admission.js';
import type { ExecutionOwner } from '../../runtime/execution-owner.js';
import type { DiscussionRunDescriptor } from '../discussion-run.js';

export interface ProviderJobLaunchPort {
  launchInitialProviderJob(
    provider: BoundProvider,
    preparedSession: ProviderSession,
    request: ProviderRequest,
    opts: {
      owner: ExecutionOwner;
      requestedJobId?: string;
      pool?: LaunchPool;
      projectRoot?: string;
      parentWorkflowJobId?: string;
      workflowSlotId?: string;
      workflowSlotGeneration?: number;
      replacesWorkflowJobId?: string;
      retention?: RetentionPolicy;
      discussionRun?: DiscussionRunDescriptor;
      mintProtectedEnv: (jobId: string) => Record<string, string>;
    },
  ): ProviderSessionLaunchDecision;

  launchResumedProviderJob(
    provider: BoundProvider,
    session: ProviderSession,
    request: ProviderRequest,
    opts: {
      owner: ExecutionOwner;
      expectedVersion: number;
      sessionBusyMessage: string;
      requestedJobId?: string;
      pool?: LaunchPool;
      projectRoot?: string;
      parentWorkflowJobId?: string;
      workflowSlotId?: string;
      workflowSlotGeneration?: number;
      replacesWorkflowJobId?: string;
      retention?: RetentionPolicy;
      discussionRun?: DiscussionRunDescriptor;
      mintProtectedEnv: (jobId: string) => Record<string, string>;
    },
  ): ProviderSessionLaunchDecision;

  launchWorkflowReplacement(
    provider: BoundProvider,
    session: ProviderSession,
    request: ProviderRequest,
    opts: {
      owner: Extract<ExecutionOwner, { kind: 'workflow' }>;
      parentWorkflowJobId: string;
      workflowSlotId: string;
      workflowSlotGeneration: number;
      replacesWorkflowJobId: string;
      pool?: LaunchPool;
      projectRoot: string;
      mintProtectedEnv: (jobId: string) => Record<string, string>;
    },
  ): ProviderSessionLaunchDecision;
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
    provider: BoundProvider,
    launchRecord: JobLaunch,
    queuedHandle: QueuedHandle,
    pool: LaunchPool,
    protectedEnv: Readonly<Record<string, string>>,
  ): void;
  writeJobTerminal(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
}
