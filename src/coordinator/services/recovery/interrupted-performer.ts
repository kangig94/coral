import { join } from 'node:path';

import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage, formatError } from '../../../infra/error-format.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import type { InterruptedProbeOutcome } from '../../../jobs/reconcile/interrupted-reason.js';
import type { JobTerminalInput } from '../../../jobs/records.js';
import type { ProviderArtifactHandleInput, ProviderTerminalEventBody } from '../../../providers/contract.js';
import type { BoundProvider, BoundProviderHostPreparationInput } from '../../../providers/bound-provider-contract.js';
import type { Runtime } from '../../../runtime/ports.js';
import { readContinuityRef } from '../../../sessions/continuity.js';
import type { ContinuitySnapshot } from '../../../sessions/continuity.js';
import type { ProviderValidatedSessionContinuityMutation } from '../../../sessions/continuity-mutation.js';
import type { AppServerInterruptedRecoveryPlan, DurableInterruptedRecoveryPlan } from './interrupted-plan.js';

export type PerformedInterruptedRecovery =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'resolved';
      mutation: ProviderValidatedSessionContinuityMutation;
      probeOutcome: InterruptedProbeOutcome;
      recoveryConversationRef: string | undefined;
      artifactHandles: readonly ProviderArtifactHandleInput[];
    }>;

export type PerformedDurableRecovery = Readonly<{
  kind: 'durable-resolved';
  terminal:
    | Readonly<{ kind: 'persisted'; value: JobTerminalInput }>
    | Readonly<{ kind: 'provider'; value: ProviderTerminalEventBody }>
    | Readonly<{ kind: 'recovery-fault'; message: string }>
    | Readonly<{ kind: 'direct'; value: JobTerminalInput }>;
  mutation: ProviderValidatedSessionContinuityMutation;
  artifactHandles: readonly ProviderArtifactHandleInput[];
}>;

type PerformerRuntime = Readonly<{
  time: Pick<Runtime['time'], 'now'>;
  env: Pick<Runtime['env'], 'fullSnapshot' | 'platform'>;
  storage: Pick<Runtime['storage'], 'readFileSync' | 'existsSync' | 'readdirSync' | 'statSync'>;
  jobDir(jobId: string): string;
  signal?: AbortSignal;
}>;

function replacementInput(
  plan: AppServerInterruptedRecoveryPlan,
  runtime: PerformerRuntime,
): BoundProviderHostPreparationInput {
  return {
    request: plan.request,
    persistedContinuity: plan.continuity,
    baseEnv: runtime.env.fullSnapshot(),
    platform: runtime.env.platform(),
    storage: runtime.storage,
  };
}

/** Performs only bound-provider, host, and read-only artifact effects for an app-server recovery plan. */
export async function performInterruptedAppServerRecovery(
  plan: AppServerInterruptedRecoveryPlan,
  boundProvider: BoundProvider,
  runtime: PerformerRuntime,
): Promise<PerformedInterruptedRecovery> {
  if (plan.kind === 'unsupported') return Object.freeze({ kind: 'unsupported' });
  const recovery = boundProvider.recovery;
  if (recovery === undefined) {
    throw new Error(`Provider '${plan.launchRecord.provider}' lost its interrupted recovery capability.`);
  }

  if (plan.kind === 'waiting') {
    const probeResult = {
      resumable: plan.preservedConversationRef !== undefined || plan.continuity !== undefined,
      ...(plan.continuity === undefined ? {} : { updatedContinuity: plan.continuity }),
    };
    return Object.freeze({
      kind: 'resolved',
      mutation: recovery.finalizeInterrupted(probeResult, plan.continuity, {
        preservedConversationRef: plan.preservedConversationRef,
      }),
      probeOutcome: 'waiting',
      recoveryConversationRef: plan.preservedConversationRef,
      artifactHandles: Object.freeze([]),
    });
  }

  if (plan.kind === 'artifacts') {
    const jobDir = runtime.jobDir(plan.launchRecord.jobId);
    const artifactResult = await recovery.finalizeFromArtifacts({
      stdoutPath: join(jobDir, 'stdout'),
      stderrPath: join(jobDir, 'stderr'),
      exitCode: null,
      signal: null,
      durationMs: elapsedDurationMs(plan.runtimeRecord.startTime, runtime.time.now(), `job ${plan.launchRecord.jobId}`),
      fallbackConversationRef: plan.preservedConversationRef,
      knownArtifactHandles: plan.session.artifactHandles
        .filter((artifact) => artifact.sourceJobId === plan.launchRecord.jobId)
        .map((artifact) => ({
          handle: artifact.handle,
          identity: artifact.identity,
          sourceJobId: artifact.sourceJobId,
        })),
      storage: runtime.storage,
    });
    const recoveryConversationRef =
      artifactResult.continuity === undefined
        ? plan.preservedConversationRef
        : readContinuityRef(artifactResult.continuity.conversationRef);
    const resumable = artifactResult.continuity?.resumable ?? recoveryConversationRef !== undefined;
    const providerContinuity = artifactResult.continuity?.providerContinuity ?? plan.continuity;
    return Object.freeze({
      kind: 'resolved',
      mutation: recovery.finalizeInterrupted(
        {
          resumable,
          ...(providerContinuity === undefined ? {} : { updatedContinuity: providerContinuity }),
        },
        plan.continuity,
        { preservedConversationRef: recoveryConversationRef },
      ),
      probeOutcome: resumable ? 'verified' : 'missing',
      recoveryConversationRef,
      artifactHandles: Object.freeze([...(artifactResult.artifactHandles ?? [])]),
    });
  }

  const appServer = boundProvider.appServer;
  if (appServer?.supportsProbe !== true) {
    throw new Error(`Provider '${plan.launchRecord.provider}' lost its app-server probe capability.`);
  }
  const hostInput = { ...replacementInput(plan, runtime), jobId: plan.launchRecord.jobId };
  let observation: { resumable: boolean; updatedContinuity?: typeof plan.continuity };
  let probeOutcome: InterruptedProbeOutcome;
  try {
    let probe = await appServer.probe(plan.hostRef, plan.continuity, hostInput);
    if (probe.kind === 'stale') {
      const replacement = await appServer.openReplacement(replacementInput(plan, runtime), {
        jobId: plan.launchRecord.jobId,
        signal: runtime.signal,
      });
      try {
        probe = await appServer.probe(replacement.hostRef, plan.continuity, hostInput);
        if (probe.kind === 'stale') {
          throw new Error(`Replacement provider host '${plan.launchRecord.provider}' became stale before probing.`);
        }
      } finally {
        replacement.close();
      }
    }
    observation = probe.result;
    probeOutcome = observation.resumable ? 'verified' : 'missing';
  } catch (error: unknown) {
    backendLog.error(`Probe failed for ${plan.launchRecord.jobId}: ${errorMessage(error)}`);
    observation = { resumable: false, updatedContinuity: plan.continuity };
    probeOutcome = 'unavailable';
  }
  return Object.freeze({
    kind: 'resolved',
    mutation: recovery.finalizeInterrupted(observation, plan.continuity, {
      preservedConversationRef: plan.preservedConversationRef,
    }),
    probeOutcome,
    recoveryConversationRef: plan.preservedConversationRef,
    artifactHandles: Object.freeze([]),
  });
}

function durableContinuityMutation(
  continuity:
    | (Pick<ContinuitySnapshot, 'conversationRef' | 'resumable'> & {
        providerContinuity?: ContinuitySnapshot['providerContinuity'];
      })
    | undefined,
  boundProvider: BoundProvider,
): ProviderValidatedSessionContinuityMutation {
  if (continuity === undefined) return { kind: 'preserve' };
  const decoded = boundProvider.decodeContinuity(continuity.providerContinuity);
  if (!decoded.ok) throw new TypeError(`Provider '${boundProvider.name}' produced invalid durable continuity.`);
  const providerContinuity = decoded.value;
  const conversationRef = readContinuityRef(continuity.conversationRef);
  if (!continuity.resumable) {
    return providerContinuity === undefined
      ? { kind: 'clear_non_resumable' }
      : { kind: 'clear_non_resumable', providerContinuity };
  }
  if (conversationRef !== undefined) {
    return providerContinuity === undefined
      ? { kind: 'set_resumable', conversationRef }
      : { kind: 'set_resumable', conversationRef, providerContinuity };
  }
  return providerContinuity === undefined ? { kind: 'preserve' } : { kind: 'preserve', providerContinuity };
}

/** Interprets durable process evidence through the captured BoundProvider without mutating Coral durable state. */
export async function performInterruptedDurableRecovery(
  plan: DurableInterruptedRecoveryPlan,
  boundProvider: BoundProvider,
  runtime: Pick<PerformerRuntime, 'storage' | 'time'>,
): Promise<PerformedDurableRecovery> {
  if (plan.kind === 'durable-persisted') {
    return Object.freeze({
      kind: 'durable-resolved',
      terminal: Object.freeze({ kind: 'persisted', value: plan.terminal }),
      mutation: Object.freeze({ kind: 'preserve' }),
      artifactHandles: Object.freeze([]),
    });
  }
  if (plan.kind === 'durable-aborted') {
    const terminal: JobTerminalInput = {
      content: '',
      durationMs: elapsedDurationMs(plan.launchRecord.createdAt, runtime.time.now(), `job ${plan.launchRecord.jobId}`),
      outcome: { kind: 'aborted', reason: 'user_abort' },
    };
    return Object.freeze({
      kind: 'durable-resolved',
      terminal: Object.freeze({ kind: 'direct', value: terminal }),
      mutation: Object.freeze({ kind: 'preserve' }),
      artifactHandles: Object.freeze([]),
    });
  }
  if (plan.kind === 'durable-wrapper-lost') {
    const terminal: JobTerminalInput = {
      content: '',
      durationMs: elapsedDurationMs(plan.runtimeRecord.startTime, runtime.time.now(), `job ${plan.launchRecord.jobId}`),
      outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
    };
    return Object.freeze({
      kind: 'durable-resolved',
      terminal: Object.freeze({ kind: 'direct', value: terminal }),
      mutation: Object.freeze({ kind: 'preserve' }),
      artifactHandles: Object.freeze([]),
    });
  }
  if (plan.kind === 'durable-unsupported') {
    return Object.freeze({
      kind: 'durable-resolved',
      terminal: Object.freeze({
        kind: 'recovery-fault',
        message: `Bound provider '${boundProvider.name}' does not expose durable recovery capability.`,
      }),
      mutation: Object.freeze({ kind: 'preserve' }),
      artifactHandles: Object.freeze([]),
    });
  }

  const recovery = boundProvider.recovery;
  if (recovery === undefined) {
    throw new Error(`Provider '${plan.launchRecord.provider}' lost its durable recovery capability.`);
  }
  try {
    const result = await recovery.finalizeFromArtifacts({
      stdoutPath: plan.runtimeRecord.stdoutPath,
      stderrPath: plan.runtimeRecord.stderrPath,
      exitCode: plan.exit.exitCode,
      signal: plan.exit.signal,
      durationMs: elapsedDurationMs(
        plan.runtimeRecord.startTime,
        Date.parse(plan.exit.endTime),
        `job ${plan.launchRecord.jobId}`,
      ),
      fallbackConversationRef: plan.session.conversationRef,
      knownArtifactHandles: plan.session.artifactHandles
        .filter((artifact) => artifact.sourceJobId === plan.launchRecord.jobId)
        .map((artifact) => ({
          handle: artifact.handle,
          identity: artifact.identity,
          sourceJobId: artifact.sourceJobId,
        })),
      storage: runtime.storage,
    });
    return Object.freeze({
      kind: 'durable-resolved',
      terminal: Object.freeze({ kind: 'provider', value: result.terminal }),
      mutation: Object.freeze(durableContinuityMutation(result.continuity, boundProvider)),
      artifactHandles: Object.freeze([...(result.artifactHandles ?? [])]),
    });
  } catch (error: unknown) {
    return Object.freeze({
      kind: 'durable-resolved',
      terminal: Object.freeze({ kind: 'recovery-fault', message: formatError(error) }),
      mutation: Object.freeze({ kind: 'preserve' }),
      artifactHandles: Object.freeze([]),
    });
  }
}
