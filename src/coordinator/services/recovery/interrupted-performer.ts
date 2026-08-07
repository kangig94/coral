import { join } from 'node:path';

import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage, formatError } from '../../../infra/error-format.js';
import type { MonotonicClock } from '../../../infra/monotonic-clock.js';
import {
  reapRecordedContainment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '../../../infra/process-containment.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import type { InterruptedProbeOutcome } from '../../../jobs/reconcile/interrupted-reason.js';
import type { JobTerminalInput } from '../../../jobs/records.js';
import type { ProviderOperationRuntimeMeta } from '../../../jobs/runtime-meta.js';
import { deleteProviderOperationRuntimeMeta } from '../../../jobs/runtime-meta-store.js';
import { MAX_PROXY_RECORDED_PROVIDER_ROOTS } from '../../../provider-proxy/enforcement.js';
import {
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_TEARDOWN_RESERVE_MS,
} from '../../../provider-proxy/orphan-deadline.js';
import type { ProviderArtifactHandleInput, ProviderTerminalEventBody } from '../../../providers/contract.js';
import type { BoundProvider, BoundProviderHostPreparationInput } from '../../../providers/bound-provider-contract.js';
import type { Database } from '../../../store/db.js';
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
  /**
   * Confirms — reaping via SIGTERM/SIGKILL if the recorded proxy set is still alive — that a `carrier-
   * detached` plan's carrier is gone, then best-effort deletes its committed `provider_operation.v1` row.
   * Rejects when absence cannot be confirmed inside the reap budget; the caller must not finalize the job
   * in that case.
   */
  reapCarrier(locator: ProviderOperationRuntimeMeta): Promise<void>;
}>;

/** What `reapCarrier` needs to build one recorded-containment reap: real ports at the composition root, or a
 *  fake clock/process pair in tests — see `reapProviderOperationCarrier`. */
export type CarrierReapDeps = Readonly<{
  process: Pick<Runtime['process'], 'kill' | 'isAlive'>;
  platform: NodeJS.Platform;
  db: Database;
  clock: MonotonicClock<symbol>;
  /** Injected for tests; defaults to the real per-platform `/proc` or `ps` probe, matching every other
   *  `ProcessContainmentEnvironment` composer (e.g. `provider-proxy/role-main.ts`). */
  readProcessStartedAtSeconds?(pid: number, platform: NodeJS.Platform): number | null;
}>;

/**
 * Reaps exactly the recorded proxy process group (`proxyPid`/`proxyProcessStartedAtSeconds`/
 * `proxyProcessGroupId`) and its recorded provider root (`providerRootPid`/
 * `providerRootProcessStartedAtSeconds`) — never the guardian or reaper, which are not named by these fields
 * and observe `containment-absent` on their own clocks to exit by themselves. The budget is the same total
 * window the provider-proxy's own deadline model guarantees a set is gone by at defaults (orphan timeout plus
 * teardown reserve, ~44s), so a set still inside its orphan window at boot still gets a fair reap.
 *
 * Deletion mirrors `coordinator/index.ts`'s `settled` cleanup: durable meta first, best-effort — a bookkeeping
 * failure here is logged, not thrown, because the safety-critical step (confirming the carrier is gone) has
 * already succeeded by this point, and a residual row is harmless once the job it named goes terminal.
 */
export async function reapProviderOperationCarrier(
  locator: ProviderOperationRuntimeMeta,
  deps: CarrierReapDeps,
): Promise<void> {
  const containment: RecordedContainmentIdentity = {
    pid: locator.proxyPid,
    processStartedAtSeconds: locator.proxyProcessStartedAtSeconds,
    processGroupId: locator.proxyProcessGroupId,
  };
  const providerRoots: readonly RecordedProcessIdentity[] = [
    { pid: locator.providerRootPid, processStartedAtSeconds: locator.providerRootProcessStartedAtSeconds },
  ];
  const exitDeadline = deps.clock.shiftMilliseconds(
    deps.clock.now(),
    DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS + PROXY_TEARDOWN_RESERVE_MS,
  );

  await reapRecordedContainment(containment, providerRoots, exitDeadline, {
    maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
    clock: deps.clock,
    process: deps.process,
    platform: deps.platform,
    ...(deps.readProcessStartedAtSeconds === undefined
      ? {}
      : { readProcessStartedAtSeconds: deps.readProcessStartedAtSeconds }),
  });

  try {
    deleteProviderOperationRuntimeMeta(deps.db, locator.jobId, locator.operationId);
  } catch (error: unknown) {
    backendLog.warn(
      `Failed to delete provider operation runtime meta for job '${locator.jobId}'/operation '${locator.operationId}': ${errorMessage(error)}`,
    );
  }
}

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

/**
 * Performs bound-provider, host, and read-only artifact effects for an app-server recovery plan — plus, for a
 * `carrier-detached` plan, the process-containment effect that confirms its carrier is gone before it may
 * finalize like `waiting` below.
 */
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

  if (plan.kind === 'carrier-detached') {
    // Precondition before this may finalize like `waiting`: confirm the recorded carrier is gone. A rejection
    // here (absence unconfirmed inside budget) propagates to the caller, which must leave the job nonterminal
    // rather than treat an unconfirmed carrier as safely detached.
    await runtime.reapCarrier(plan.locator);
    const probeResult = {
      resumable: plan.preservedConversationRef !== undefined || plan.continuity !== undefined,
      updatedContinuity: plan.continuity,
    };
    return Object.freeze({
      kind: 'resolved',
      mutation: recovery.finalizeInterrupted(probeResult, plan.continuity, {
        preservedConversationRef: plan.preservedConversationRef,
      }),
      probeOutcome: 'unavailable',
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
