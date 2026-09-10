import { backendLog } from '../../../infra/backend-log.js';
import { assertNever } from '../../../infra/error-format.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import type { JobStatus, JobTerminalInput } from '../../../jobs/records.js';
import type { InterruptedProbeOutcome } from '../../../jobs/reconcile/interrupted-reason.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SessionRecoveryPort } from '../../../sessions/contracts.js';
import type { SessionInterruptedFault } from '../../../sessions/fault.js';
import type { ProviderValidatedSessionContinuityMutation } from '../../../sessions/continuity-mutation.js';
import type { CommitContext } from '../../../store/append.js';
import { buildInterruptedAppServerReport } from '../execution-policies.js';
import {
  appendJobRecoveryFaultTerminalInCommit,
  appendProviderTerminalInCommit,
  appendSessionInterruptedTerminalInCommit,
} from '../terminal-materializer.js';
import { appendJobTerminalRecorded } from '../../../jobs/terminal/recording.js';
import type { JobAdmissionPort, LaunchPermit } from '../../../jobs/contracts/admission.js';
import type { AppServerInterruptedRecoveryPlan, DurableInterruptedRecoveryPlan } from './interrupted-plan.js';
import type { PerformedDurableRecovery, PerformedInterruptedRecovery } from './interrupted-performer.js';

export class InterruptedRecoveryCommitError extends Error {
  readonly jobId: string;
  readonly stage: 'artifact-handle' | 'session-finalize';
  constructor(jobId: string, stage: 'artifact-handle' | 'session-finalize') {
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
  sessionManager: Pick<SessionRecoveryPort, 'recordArtifactHandleAtomic' | 'finalizeJobContinuityAtomic'>;
  abortRegistry: JobAbortRegistryPort;
  launchAdmission: Pick<JobAdmissionPort, 'releaseLaunch'>;
  launchPermit: LaunchPermit | null;
}>;

type RecoveryCommitPlan = Pick<
  AppServerInterruptedRecoveryPlan | DurableInterruptedRecoveryPlan,
  'launchRecord' | 'session' | 'expectedSessionVersion'
>;

declare const recoveryCommitReceiptBrand: unique symbol;
type RecoveryCommitReceipt = Readonly<{
  plan: RecoveryCommitPlan;
  [recoveryCommitReceiptBrand]: true;
}>;

type TerminalAppender = <Scope>(commit: CommitContext<Scope>) => void;

async function recordArtifactHandlesExact(
  plan: RecoveryCommitPlan,
  artifacts: readonly Readonly<{
    handle: string;
    identity: Parameters<InterruptedFinalizerDeps['sessionManager']['recordArtifactHandleAtomic']>[1]['identity'];
  }>[],
  deps: InterruptedFinalizerDeps,
): Promise<number> {
  let expectedVersion = plan.expectedSessionVersion;
  for (const artifact of artifacts) {
    const recorded = await deps.sessionManager.recordArtifactHandleAtomic(plan.session.sessionId, {
      expectedActiveJobId: plan.launchRecord.jobId,
      expectedVersion,
      handle: artifact.handle,
      identity: artifact.identity,
      sourceJobId: plan.launchRecord.jobId,
    });
    if (!recorded.ok) {
      throw new InterruptedRecoveryCommitError(plan.launchRecord.jobId, 'artifact-handle');
    }
    expectedVersion = recorded.nextVersion;
  }
  return expectedVersion;
}

async function finalizeSessionExact(
  plan: RecoveryCommitPlan,
  expectedVersion: number,
  mutation: ProviderValidatedSessionContinuityMutation,
  appendBeforeRelease: TerminalAppender | undefined,
  deps: InterruptedFinalizerDeps,
): Promise<RecoveryCommitReceipt> {
  const finalized = await deps.sessionManager.finalizeJobContinuityAtomic(plan.session.sessionId, {
    expectedActiveJobId: plan.launchRecord.jobId,
    expectedVersion,
    mutation,
    appendBeforeRelease,
  });
  if (!finalized) {
    throw new InterruptedRecoveryCommitError(plan.launchRecord.jobId, 'session-finalize');
  }
  // eslint-disable-next-line no-restricted-syntax -- RecoveryCommitReceipt may only be minted by finalizeSessionExact.
  return Object.freeze({ plan }) as RecoveryCommitReceipt;
}

function exportResultAndReleaseOwnership(
  receipt: RecoveryCommitReceipt,
  content: string,
  deps: InterruptedFinalizerDeps,
): void {
  const { plan } = receipt;
  try {
    writeResultArtifact(
      deps.runtime.storage,
      deps.runtime.paths.coral.exports.jobsRoot,
      plan.launchRecord.jobId,
      content,
    );
  } catch (error: unknown) {
    backendLog.warn(`Writing terminal artifact failed for ${plan.launchRecord.jobId}: ${String(error)}`);
  }
  try {
    deps.abortRegistry.remove(plan.launchRecord.jobId);
    if (deps.launchPermit !== null) deps.launchAdmission.releaseLaunch(deps.launchPermit);
  } catch (error: unknown) {
    throw new RecoveryOwnershipReleaseError(plan.launchRecord.jobId, error);
  }
}

function continuityState(
  probeOutcome: InterruptedProbeOutcome,
  mutation: ProviderValidatedSessionContinuityMutation,
): SessionInterruptedFault['continuity'] {
  switch (probeOutcome) {
    case 'verified':
    case 'missing':
    case 'unavailable':
      return probeOutcome;
    case 'waiting':
      return mutation.kind === 'clear_non_resumable' ? 'pre_checkpoint_empty' : 'pre_checkpoint_preserved';
    default:
      return assertNever(probeOutcome);
  }
}

/** Commits an app-server recovery outcome, then releases local ownership only after exact session CAS. */
export async function finalizeInterruptedAppServerRecovery(
  plan: AppServerInterruptedRecoveryPlan,
  performed: PerformedInterruptedRecovery,
  status: JobStatus,
  deps: InterruptedFinalizerDeps,
): Promise<void> {
  const expectedVersion = await recordArtifactHandlesExact(
    plan,
    performed.kind === 'resolved' ? performed.artifactHandles : [],
    deps,
  );

  const terminalOptions = {
    jobId: plan.launchRecord.jobId,
    sessionId: plan.session.sessionId,
    namespace: status.backendNamespace,
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
    appendTerminal = directTerminalAppender(status, {
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
    const fault: SessionInterruptedFault = {
      trigger: plan.reason,
      continuity: continuityState(performed.probeOutcome, mutation),
    };
    const reportConversationRef =
      performed.probeOutcome === 'verified'
        ? mutation.kind === 'set_resumable'
          ? mutation.conversationRef
          : performed.recoveryConversationRef
        : undefined;
    content = buildInterruptedAppServerReport(fault, reportConversationRef);
    appendTerminal = <Scope>(commit: CommitContext<Scope>): void => {
      appendSessionInterruptedTerminalInCommit(commit, fault, terminalOptions, { content, durationMs });
    };
  }

  const receipt = await finalizeSessionExact(plan, expectedVersion, mutation, appendTerminal, deps);
  exportResultAndReleaseOwnership(receipt, content, deps);
}

function directTerminalAppender(status: JobStatus, terminal: JobTerminalInput): TerminalAppender {
  return <Scope>(commit: CommitContext<Scope>): void => {
    appendJobTerminalRecorded(commit, {
      jobId: status.jobId,
      sessionId: status.sessionId,
      namespace: status.backendNamespace,
      project: status.projectRoot,
      terminal,
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
  const expectedVersion = await recordArtifactHandlesExact(plan, performed.artifactHandles, deps);
  const terminalOptions = {
    jobId: plan.launchRecord.jobId,
    sessionId: plan.session.sessionId,
    namespace: status.backendNamespace,
    project: status.projectRoot,
  };
  const durationMs = elapsedDurationMs(
    plan.runtimeRecord.startTime,
    deps.runtime.time.now(),
    `job ${plan.launchRecord.jobId}`,
  );

  let content: string;
  let appendTerminal: TerminalAppender | undefined;
  switch (performed.terminal.kind) {
    case 'persisted':
      content = performed.terminal.value.content;
      appendTerminal = undefined;
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
      appendTerminal = directTerminalAppender(status, performed.terminal.value);
      break;
    default:
      return assertNever(performed.terminal);
  }

  const receipt = await finalizeSessionExact(plan, expectedVersion, performed.mutation, appendTerminal, deps);
  exportResultAndReleaseOwnership(receipt, content, deps);
}
