import { assertNever } from '../../../infra/error-format.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import type { JobStatus, JobTerminal } from '../../../jobs/records.js';
import { ExecutionAcceptanceRefusedError, type ExecutionFinisher } from '../../../jobs/finishing.js';
import { providerArtifactIdentityKey } from '../../../providers/artifact-identity.js';
import type { ProviderArtifactHandleInput } from '../../../providers/contract.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ConversationRecoveryPort } from '../../../jobs/conversation/contracts.js';
import type { ConversationInterruptedFault } from '../../../jobs/conversation/fault.js';
import type { ProviderValidatedSessionContinuityMutation } from '../../../jobs/conversation/continuity-mutation.js';
import type { CommitContext } from '../../../store/append.js';
import { buildInterruptedAppServerReport } from '../execution-policies.js';
import {
  appendJobRecoveryFaultTerminalInCommit,
  appendProviderTerminalInCommit,
  appendConversationInterruptedTerminalInCommit,
} from '../terminal-materializer.js';
import { appendJobExecutionOutcomeAccepted } from '../../../jobs/terminal/recording.js';
import type { JobAdmissionPort, LaunchPermit } from '../../../jobs/contracts/admission.js';
import type { AppServerInterruptedRecoveryPlan, DurableInterruptedRecoveryPlan } from './interrupted-plan.js';
import type { PerformedDurableRecovery, PerformedInterruptedRecovery } from './interrupted-performer.js';

export class InterruptedRecoveryCommitError extends ExecutionAcceptanceRefusedError {
  readonly jobId: string;
  readonly stage: 'execution-checkpoint';
  constructor(jobId: string, stage: 'execution-checkpoint') {
    super(`Interrupted app-server recovery commit failed for ${jobId} at ${stage}.`);
    this.name = 'InterruptedRecoveryCommitError';
    this.jobId = jobId;
    this.stage = stage;
  }
}

export class RecoveryOwnershipReleaseError extends Error {
  readonly jobId: string;

  constructor(jobId: string, cause: unknown) {
    super(`Recovery ownership release is incomplete for ${jobId}.`, { cause });
    this.name = 'RecoveryOwnershipReleaseError';
    this.jobId = jobId;
  }
}

type InterruptedFinalizerDeps = Readonly<{
  runtime: Pick<Runtime, 'storage' | 'paths' | 'time'>;
  conversationManager: Pick<ConversationRecoveryPort, 'readById'>;
  executionFinisher: ExecutionFinisher;
  abortRegistry: JobAbortRegistryPort;
  launchAdmission: Pick<JobAdmissionPort, 'releaseLaunch'>;
  launchPermit: LaunchPermit | null;
}>;

type RecoveryCommitPlan = Pick<AppServerInterruptedRecoveryPlan | DurableInterruptedRecoveryPlan, 'launchRecord'>;

type TerminalAppender = <Scope>(commit: CommitContext<Scope>) => void;

async function acceptRecoveryOutcome(
  plan: RecoveryCommitPlan,
  mutation: ProviderValidatedSessionContinuityMutation,
  artifacts: readonly ProviderArtifactHandleInput[],
  appendTerminal: TerminalAppender,
  deps: InterruptedFinalizerDeps,
): Promise<void> {
  const { jobId, execution } = plan.launchRecord;
  const address = { jobId, execution };
  await deps.executionFinisher.accept(address, (commit) => {
    const entry = deps.conversationManager.readById(jobId);
    if (entry === null || !entry.open || entry.finishing || entry.execution !== execution) {
      throw new InterruptedRecoveryCommitError(jobId, 'execution-checkpoint');
    }
    const identities = new Set(
      entry.artifactHandles
        .filter((artifact) => artifact.execution === execution)
        .map((artifact) => artifact.identityKey),
    );
    for (const artifact of artifacts) {
      const identityKey = providerArtifactIdentityKey(entry.binding.provider, artifact.identity);
      if (identities.has(identityKey)) continue;
      commit.append({
        type: 'job.artifact.recorded',
        stream: { kind: 'job', id: jobId },
        refs: { jobId },
        body: {
          execution,
          provider: entry.binding.provider,
          handle: artifact.handle,
          identity: artifact.identity,
          identityKey,
        },
      });
      identities.add(identityKey);
    }
    if (mutation.kind !== 'preserve' || mutation.providerContinuity !== undefined) {
      const conversationRef =
        mutation.kind === 'set_resumable'
          ? mutation.conversationRef
          : mutation.kind === 'clear_non_resumable'
            ? null
            : (entry.conversationRef ?? null);
      commit.append({
        type: 'job.continuity.checkpointed',
        stream: { kind: 'job', id: jobId },
        refs: { jobId },
        body: {
          execution,
          snapshot: {
            conversationRef,
            resumable: mutation.kind === 'set_resumable' || (mutation.kind === 'preserve' && conversationRef !== null),
            providerContinuity: mutation.providerContinuity ?? entry.providerContinuity,
          },
        },
      });
    }
    appendTerminal(commit);
    return undefined;
  });
  releaseLocalOwnership(plan, deps);
  deps.executionFinisher.schedule(address);
}

function releaseLocalOwnership(plan: RecoveryCommitPlan, deps: InterruptedFinalizerDeps): void {
  try {
    deps.abortRegistry.remove(plan.launchRecord.jobId, plan.launchRecord.execution);
    if (deps.launchPermit !== null) {
      const release = deps.launchAdmission.releaseLaunch(deps.launchPermit);
      if (release.kind === 'transferred') {
        throw new Error(`Launch ownership transferred to ${JSON.stringify(release.holder)}.`);
      }
    }
  } catch (error: unknown) {
    throw new RecoveryOwnershipReleaseError(plan.launchRecord.jobId, error);
  }
}

function continuityState(
  mutation: ProviderValidatedSessionContinuityMutation,
): ConversationInterruptedFault['continuity'] {
  return mutation.kind === 'clear_non_resumable' ? 'pre_checkpoint_empty' : 'pre_checkpoint_preserved';
}

export async function finalizeInterruptedAppServerRecovery(
  plan: AppServerInterruptedRecoveryPlan,
  performed: PerformedInterruptedRecovery,
  status: JobStatus,
  deps: InterruptedFinalizerDeps,
): Promise<void> {
  const terminalOptions = {
    jobId: plan.launchRecord.jobId,
    execution: plan.launchRecord.execution,
    namespace: status.backendNamespace ?? undefined,
    project: status.projectRoot,
  };
  const durationMs = elapsedDurationMs(
    plan.runtimeRecord.startTime,
    deps.runtime.time.now(),
    `job ${plan.launchRecord.jobId}`,
  );
  let content: string;
  let mutation: ProviderValidatedSessionContinuityMutation;
  let appendTerminal: TerminalAppender;
  if (performed.kind === 'user-aborted') {
    if (plan.reason !== 'user_abort') {
      throw new Error(
        `Recovered app-server user-abort evidence does not match finalization reason for ${status.jobId}.`,
      );
    }
    content = '';
    mutation = { kind: 'preserve' };
    appendTerminal = directTerminalAppender(plan, status, {
      content,
      durationMs,
      outcome: { kind: 'aborted', reason: 'user_abort' },
    });
  } else if (performed.kind === 'unsupported') {
    content = '';
    mutation = { kind: 'preserve' };
    const fault = {
      kind: 'recovery_parse_failed',
      cause: {
        message: `Bound provider '${plan.launchRecord.provider}' does not expose app-server recovery capability.`,
      },
    } as const;
    appendTerminal = <Scope>(commit: CommitContext<Scope>): void => {
      appendJobRecoveryFaultTerminalInCommit(commit, fault, terminalOptions, { content, durationMs });
    };
  } else {
    if (plan.reason === 'user_abort') {
      throw new Error(
        `Recovered app-server user-abort finalization lacks provider acknowledgment for ${status.jobId}.`,
      );
    }
    mutation = performed.mutation;
    const fault: ConversationInterruptedFault = {
      trigger: plan.reason,
      continuity: continuityState(mutation),
    };
    content = buildInterruptedAppServerReport(fault);
    appendTerminal = <Scope>(commit: CommitContext<Scope>): void => {
      appendConversationInterruptedTerminalInCommit(commit, fault, terminalOptions, { content, durationMs });
    };
  }

  await acceptRecoveryOutcome(plan, mutation, [], appendTerminal, deps);
}

function directTerminalAppender(plan: RecoveryCommitPlan, status: JobStatus, terminal: JobTerminal): TerminalAppender {
  return <Scope>(commit: CommitContext<Scope>): void => {
    appendJobExecutionOutcomeAccepted(commit, {
      jobId: status.jobId,
      execution: plan.launchRecord.execution,
      namespace: status.backendNamespace ?? undefined,
      project: status.projectRoot,
      terminal: {
        ...terminal,
        outcome:
          terminal.outcome.kind === 'failed'
            ? { kind: 'failed', causeRef: terminal.outcome.causeRef }
            : terminal.outcome,
      },
    });
  };
}

/** Commits durable-process recovery evidence without reinterpreting provider protocol state. */
export async function finalizeInterruptedDurableRecovery(
  plan: DurableInterruptedRecoveryPlan,
  performed: PerformedDurableRecovery,
  status: JobStatus,
  deps: InterruptedFinalizerDeps,
): Promise<void> {
  const terminalOptions = {
    jobId: plan.launchRecord.jobId,
    execution: plan.launchRecord.execution,
    namespace: status.backendNamespace ?? undefined,
    project: status.projectRoot,
  };
  const durationMs = elapsedDurationMs(
    plan.runtimeRecord.startTime,
    deps.runtime.time.now(),
    `job ${plan.launchRecord.jobId}`,
  );

  let content: string;
  let appendTerminal: TerminalAppender;
  switch (performed.terminal.kind) {
    case 'persisted':
      content = performed.terminal.value.content;
      appendTerminal = directTerminalAppender(plan, status, performed.terminal.value);
      break;
    case 'provider': {
      const providerTerminal = performed.terminal.value;
      content = providerTerminal.terminal.content;
      appendTerminal = <Scope>(commit: CommitContext<Scope>): void => {
        appendProviderTerminalInCommit(commit, providerTerminal, terminalOptions);
      };
      break;
    }
    case 'recovery-fault': {
      content = '';
      const fault = {
        kind: 'recovery_parse_failed',
        cause: { message: performed.terminal.message },
      } as const;
      appendTerminal = <Scope>(commit: CommitContext<Scope>): void => {
        appendJobRecoveryFaultTerminalInCommit(commit, fault, terminalOptions, { content, durationMs });
      };
      break;
    }
    case 'direct':
      content = performed.terminal.value.content;
      appendTerminal = directTerminalAppender(plan, status, performed.terminal.value);
      break;
    default:
      return assertNever(performed.terminal);
  }

  await acceptRecoveryOutcome(plan, performed.mutation, performed.artifactHandles, appendTerminal, deps);
}
