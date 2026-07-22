import { backendLog } from '../../../infra/backend-log.js';
import { assertNever } from '../../../infra/error-format.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import type { JobStatus, JobTerminalInput } from '../../../jobs/records.js';
import type { InterruptedProbeOutcome } from '../../../jobs/reconcile/interrupted-reason.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import type { LaunchPool } from '../../../jobs/contracts/admission.js';
import type { JobAdmissionPort } from '../../../jobs/contracts/admission.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SessionRecoveryPort } from '../../../sessions/contracts.js';
import type { SessionInterruptedFault } from '../../../sessions/fault.js';
import type { SessionContinuityMutation } from '../../../sessions/continuity-mutation.js';
import type { CommitContext } from '../../../store/append.js';
import { buildInterruptedAppServerReport } from '../execution-policies.js';
import {
  appendJobRecoveryFaultTerminalInCommit,
  appendProviderTerminalInCommit,
  appendSessionInterruptedTerminalInCommit,
} from '../terminal-materializer.js';
import { appendJobTerminalRecorded } from '../../../jobs/terminal/recording.js';
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

type InterruptedFinalizerDeps = Readonly<{
  runtime: Pick<Runtime, 'storage' | 'paths' | 'time'>;
  sessionManager: Pick<SessionRecoveryPort, 'recordArtifactHandleAtomic' | 'finalizeJobContinuityAtomic'>;
  abortRegistry: JobAbortRegistryPort;
  launchAdmission: Pick<JobAdmissionPort, 'releaseLaunch'>;
  jobPools: Map<string, LaunchPool>;
}>;

type RecoveryCommitPlan = Pick<
  AppServerInterruptedRecoveryPlan | DurableInterruptedRecoveryPlan,
  'launchRecord' | 'session' | 'expectedSessionVersion'
>;

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
  mutation: SessionContinuityMutation,
  appendBeforeRelease: TerminalAppender | undefined,
  deps: InterruptedFinalizerDeps,
): Promise<void> {
  const finalized = await deps.sessionManager.finalizeJobContinuityAtomic(plan.session.sessionId, {
    expectedActiveJobId: plan.launchRecord.jobId,
    expectedVersion,
    mutation,
    appendBeforeRelease,
  });
  if (!finalized) {
    throw new InterruptedRecoveryCommitError(plan.launchRecord.jobId, 'session-finalize');
  }
}

function exportResultAndReleaseOwnership(
  plan: RecoveryCommitPlan,
  content: string,
  deps: InterruptedFinalizerDeps,
): void {
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
  const pool = deps.jobPools.get(plan.launchRecord.jobId) ?? plan.launchRecord.pool;
  deps.abortRegistry.remove(plan.launchRecord.jobId);
  deps.jobPools.delete(plan.launchRecord.jobId);
  deps.launchAdmission.releaseLaunch(plan.launchRecord.jobId, pool);
}

function continuityState(
  probeOutcome: InterruptedProbeOutcome,
  mutation: SessionContinuityMutation,
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
  let mutation: SessionContinuityMutation;
  let appendTerminal: TerminalAppender;
  if (performed.kind === 'unsupported') {
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

  await finalizeSessionExact(plan, expectedVersion, mutation, appendTerminal, deps);
  exportResultAndReleaseOwnership(plan, content, deps);
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

  await finalizeSessionExact(plan, expectedVersion, performed.mutation, appendTerminal, deps);
  exportResultAndReleaseOwnership(plan, content, deps);
}
