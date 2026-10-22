import type { JobSendTarget } from '../send-target.js';
import type { ProviderRequest } from '../../providers/contract.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import type { RetentionPolicy, JobConversation } from '../conversation/entry.js';
import type { TerminalWriteOptions } from './job-store.js';
import type { JobPhase } from '../phase.js';
import type { ProviderJobLaunchDecision } from '../launch.js';
import type { JobLaunch, JobTerminal } from '../records.js';
import type { LaunchPool, QueuedHandle } from './admission.js';
import type { ExecutionOwner } from '../../runtime/execution-owner.js';
import type { DiscussionRunDescriptor } from '../discussion-run.js';
import type { ProviderOperationEnvironmentInput } from './provider-operation-lifecycle.js';

export interface ProviderJobLaunchPort {
  launchExecution(
    provider: BoundProvider,
    conversation: JobConversation,
    request: ProviderRequest,
    opts: {
      owner: ExecutionOwner;
      pool?: LaunchPool;
      parentWorkflowJobId?: string;
      workflowSlotId?: string;
      retention?: RetentionPolicy;
      discussionRun?: DiscussionRunDescriptor;
      originatingClientMessageId?: string;
      continuationTarget?: JobSendTarget;
      mintProtectedEnv: (jobId: string, execution: number) => ProviderOperationEnvironmentInput;
    },
  ): Promise<ProviderJobLaunchDecision>;
}

export interface WorkflowJobLifecyclePort {
  markJobRunning(jobId: string): void;
  writeJobTerminal(
    jobId: string,
    execution: number,
    result: JobTerminal,
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
    protectedEnv: ProviderOperationEnvironmentInput,
  ): void;
  writeJobTerminal(
    jobId: string,
    execution: number,
    result: JobTerminal,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
}
