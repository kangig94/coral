import type { ProviderRequest, ProviderServerLease, ProviderServerSpec } from '../../../providers/contract.js';
import { join } from 'node:path';
import {
  readContinuityRef,
  type ContinuitySnapshot,
  type ProviderContinuityBlob,
} from '../../../sessions/continuity.js';
import type { SessionContinuityMutation } from '../../../sessions/continuity-mutation.js';
import { backendLog } from '../../../infra/backend-log.js';
import { assertNever, errorMessage } from '../../../infra/error-format.js';
import type { SessionInterruptedFault } from '../../../sessions/fault.js';
import {
  isAppServerRuntime,
  type AppServerRuntime,
  type JobLaunch,
  type JobRuntime,
  type JobStatus,
  type JobTerminalInput,
} from '../../../jobs/records.js';
import { isTerminalPhase, type JobPhase } from '../../../jobs/phase.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import { providerSessionProvider, type ProviderSession } from '../../../sessions/entry.js';
import { nowIsoString } from '../../../infra/time.js';
import type { ProviderBindingCatalog } from '../../../providers/catalog.js';
import type { ProviderBindingFailure } from '../../../providers/contracts/binding.js';
import type { ProviderArtifactHandleInput } from '../../../providers/contract.js';
import type { ExecutionProviderServerAttachment, ExecutionProviderHostManager } from '../../contracts.js';
import type { JobAdmissionPort, JobLaunchRecoveryPort, LaunchPool } from '../../../jobs/contracts/admission.js';
import type { JobProgressStore, TerminalWriteOptions } from '../../../jobs/contracts/job-store.js';
import type { SessionRecoveryPort } from '../../../sessions/contracts.js';
import type { Runtime } from '../../../runtime/ports.js';
import type {
  BoundProvider,
  BoundProviderPreparedExecution,
  BoundProviderRecovery,
} from '../../../providers/bound-provider-contract.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { RecoveredJobLifecyclePort } from '../../../jobs/contracts/job-runner.js';
import type {
  ProviderRecoveryAuthority,
  ProviderRecoveryLaunch,
  ProviderRecoverySession,
} from '../../../jobs/reconcile/contracts.js';
import { toProviderRequest } from '../../../jobs/provider-request.js';
import { FINALIZE_CONTINUITY_MAX_RETRIES, buildInterruptedAppServerReport } from '../execution-policies.js';
import type {
  InterruptedAppServerReason,
  InterruptedProbeOutcome,
} from '../../../jobs/reconcile/interrupted-reason.js';
import { recordJobRecoveryFaultTerminal, recordSessionInterruptedTerminal } from '../terminal-materializer.js';
import {
  CHILD_PRINCIPAL_CAPABILITIES,
  CORAL_CHILD_PRINCIPAL_HANDLE,
  type ChildPrincipalRegistry,
} from '../../child-principal-registry.js';
import type { Principal } from '../../../security/principal.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import { snapshotProviderRecoveryAuthority } from './authority-snapshot.js';

function requireProviderLaunchRecord(
  launchRecord: JobLaunch,
  operation: string,
): asserts launchRecord is ProviderRecoveryLaunch {
  if (launchRecord.jobKind !== 'provider' || launchRecord.sessionId === null || launchRecord.provider === null) {
    throw new Error(`${operation} requires a provider launch record.`);
  }
}

function interruptedContinuityState(
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

export interface RecoveryServiceDeps {
  runtime: Runtime;
  sessionManager: SessionRecoveryPort;
  abortRegistry: JobAbortRegistryPort;
  backendNamespace: string;
  bundleHash: string;
  progressStore: JobProgressStore;
  providerHostManager: ExecutionProviderHostManager;
  launchAdmission: Pick<JobAdmissionPort, 'releaseLaunch'>;
  launchRecovery: JobLaunchRecoveryPort;
  providerRegistry: ProviderBindingCatalog;
  jobPools: Map<string, LaunchPool>;
  launchOrchestrator: RecoveredJobLifecyclePort;
  childPrincipalRegistry: ChildPrincipalRegistry;
  parentPrincipal: Principal;
  acquireServer?: (
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ) => Promise<ProviderServerLease>;
}

export class RecoveryService {
  private readonly deps: RecoveryServiceDeps;
  constructor(deps: RecoveryServiceDeps) {
    this.deps = deps;
  }

  private prepareRecoveryExecution(
    bound: BoundProvider,
    session: ProviderRecoverySession,
    request: ProviderRequest,
    jobId: string,
  ): BoundProviderPreparedExecution {
    return bound.prepareExecution({
      request,
      baseEnv: this.deps.runtime.env.fullSnapshot(),
      protectedEnv: this.recoveryChildEnv(session, jobId),
      platform: this.deps.runtime.env.platform(),
    });
  }

  private recoveryChildEnv(session: ProviderRecoverySession, jobId: string): Readonly<Record<string, string>> {
    const childCredential = this.deps.childPrincipalRegistry.register({
      issuer: 'job-recovery',
      parentPrincipal: this.deps.parentPrincipal,
      namespace: this.deps.backendNamespace,
      parentJobId: jobId,
      parentSessionId: session.sessionId,
      nowMs: this.deps.runtime.time.now(),
      childCaps: CHILD_PRINCIPAL_CAPABILITIES,
    });
    return Object.freeze({
      CORAL_JOB_ID: jobId,
      CORAL_SESSION_ID: session.sessionId,
      [CORAL_CHILD_PRINCIPAL_HANDLE]: childCredential.handle,
    });
  }

  private async readProviderSession(
    launchRecord: JobLaunch,
  ): Promise<
    { ok: true; session: ProviderSession; bound: BoundProvider } | { ok: false; failure: ProviderBindingFailure }
  > {
    const provider = launchRecord.provider;
    if (provider === null || launchRecord.sessionId === null) {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider: provider ?? 'unknown' } };
    }
    let session: ProviderSession | null;
    try {
      session = this.deps.sessionManager.readById(launchRecord.sessionId, { forceFresh: true });
    } catch {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    }
    if (session === null) return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    if (providerSessionProvider(session) !== launchRecord.provider) {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    }
    const binding = this.deps.providerRegistry.rehydrateBinding(session.binding);
    if (!binding.ok) return { ok: false, failure: binding.failure };
    if (binding.value.name !== provider) {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    }
    const readiness = await binding.value.readiness('recovery', this.deps.runtime.storage);
    if (!readiness.ok) return { ok: false, failure: readiness.failure };
    return { ok: true, session, bound: binding.value };
  }

  private failBindingIntegrity(launchRecord: JobLaunch, failure: ProviderBindingFailure): void {
    if (launchRecord.sessionId === null) return;
    const message = this.deps.providerRegistry.renderBindingFailure(failure);
    this.completeRecoveredJob(
      launchRecord.jobId,
      launchRecord.sessionId,
      {
        content: message,
        durationMs: elapsedDurationMs(
          launchRecord.createdAt,
          this.deps.runtime.time.now(),
          `job ${launchRecord.jobId}`,
        ),
        outcome: {
          kind: 'job_fault',
          fault: { kind: 'provider_binding', provider: failure.provider, reason: failure.reason, message },
        },
      },
      'error',
      { pool: launchRecord.pool },
    );
  }

  async captureProviderRecoveryAuthority(launchRecord: JobLaunch): Promise<ProviderRecoveryAuthority | null> {
    requireProviderLaunchRecord(launchRecord, 'captureProviderRecoveryAuthority');
    const result = await this.readProviderSession(launchRecord);
    if (result.ok) {
      return snapshotProviderRecoveryAuthority(launchRecord, result.session, result.bound);
    }
    this.failBindingIntegrity(launchRecord, result.failure);
    return null;
  }

  private requestServer(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ProviderServerLease> {
    return this.deps.acquireServer ? this.deps.acquireServer(spec, options) : this.acquireServer(spec, options);
  }

  async acquireServer(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ProviderServerLease> {
    const transportMode = spec.runtimeMetadata?.transportMode;
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, {
        leaseState: 'waiting',
        ...(transportMode === undefined ? {} : { transportMode }),
      });
    }

    const lease = await this.deps.providerHostManager.acquireServer(spec, { signal: options?.signal });
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, {
        leaseState: 'acquired',
        serverGeneration: lease.generation,
        ...(transportMode === undefined ? {} : { transportMode }),
      });
    }
    return lease;
  }

  async interruptAppServerJob(authority: ProviderRecoveryAuthority, runtimeRecord: AppServerRuntime): Promise<void> {
    const { launchRecord, session, boundProvider } = authority;
    const request = toProviderRequest(launchRecord, session.conversationRef);
    const prepared = this.prepareRecoveryExecution(boundProvider, session, request, launchRecord.jobId);
    const appServer = prepared.appServer;
    if (!appServer?.interrupt) return;
    const continuity = this.sessionProviderContinuity(session);
    if (!continuity) {
      return;
    }

    const spec = appServer.buildServerSpec(continuity, { storage: this.deps.runtime.storage });
    const liveServer = await this.deps.providerHostManager.borrowLiveServer(spec, {
      serverGeneration: runtimeRecord.providerMeta.serverGeneration,
    });
    if (liveServer) {
      await appServer.interrupt(this.createAttachedProviderServerLease(liveServer), continuity);
      return;
    }
    backendLog.warn(`Cannot interrupt recovered app-server job ${launchRecord.jobId}: bound provider server is gone.`);
  }

  private async recoverInterruptedContinuityFromArtifacts(options: {
    launchRecord: ProviderRecoveryLaunch;
    runtimeRecord: AppServerRuntime;
    session: ProviderRecoverySession;
    recovery: BoundProviderRecovery;
    continuity: ProviderContinuityBlob | undefined;
    preservedConversationRef: string | undefined;
  }): Promise<{ mutation: SessionContinuityMutation; probeOutcome: InterruptedProbeOutcome }> {
    const { launchRecord, runtimeRecord, session, recovery, continuity, preservedConversationRef } = options;
    const jobDir = this.deps.progressStore.jobDir(launchRecord.jobId);
    const artifactResult = await recovery.finalizeFromArtifacts({
      stdoutPath: join(jobDir, 'stdout'),
      stderrPath: join(jobDir, 'stderr'),
      exitCode: null,
      signal: null,
      durationMs: elapsedDurationMs(runtimeRecord.startTime, this.deps.runtime.time.now(), `job ${launchRecord.jobId}`),
      fallbackConversationRef: preservedConversationRef,
      knownArtifactHandles: session.artifactHandles
        .filter((artifact) => artifact.sourceJobId === launchRecord.jobId)
        .map((artifact) => ({
          handle: artifact.handle,
          identity: artifact.identity,
          sourceJobId: artifact.sourceJobId,
        })),
      storage: this.deps.runtime.storage,
    });
    if (artifactResult.artifactHandles && artifactResult.artifactHandles.length > 0) {
      await this.recordRecoveredArtifactHandles(launchRecord.sessionId, {
        jobId: launchRecord.jobId,
        handles: artifactResult.artifactHandles,
      });
    }
    const recoveredConversationRef =
      artifactResult.continuity === undefined
        ? preservedConversationRef
        : readContinuityRef(artifactResult.continuity.conversationRef);
    const artifactResumable = artifactResult.continuity?.resumable ?? recoveredConversationRef !== undefined;
    const recoveredProviderContinuity = artifactResult.continuity?.providerContinuity ?? continuity;
    const mutation = recovery.finalizeInterrupted(
      {
        resumable: artifactResumable,
        ...(recoveredProviderContinuity === undefined ? {} : { updatedContinuity: recoveredProviderContinuity }),
      },
      continuity,
      { preservedConversationRef: recoveredConversationRef },
    );
    return {
      mutation,
      probeOutcome: artifactResumable ? 'verified' : 'missing',
    };
  }

  private async materializeInterruptedAppServerRecovery(options: {
    launchRecord: ProviderRecoveryLaunch;
    runtimeRecord: AppServerRuntime;
    status: JobStatus;
    reason: InterruptedAppServerReason;
    probeOutcome: InterruptedProbeOutcome;
    mutation: SessionContinuityMutation;
    recoveryConversationRef: string | undefined;
  }): Promise<void> {
    const { launchRecord, runtimeRecord, status, reason, probeOutcome, mutation, recoveryConversationRef } = options;
    const fault: SessionInterruptedFault = {
      trigger: reason,
      continuity: interruptedContinuityState(probeOutcome, mutation),
    };
    const reportConversationRef =
      probeOutcome === 'verified'
        ? mutation.kind === 'set_resumable'
          ? mutation.conversationRef
          : recoveryConversationRef
        : undefined;
    const interruptedReport = buildInterruptedAppServerReport(fault, reportConversationRef);

    recordSessionInterruptedTerminal(
      this.deps.progressStore,
      fault,
      {
        jobId: launchRecord.jobId,
        sessionId: launchRecord.sessionId,
        namespace: status.backendNamespace,
        project: status.projectRoot,
      },
      {
        content: interruptedReport,
        durationMs: elapsedDurationMs(
          runtimeRecord.startTime,
          this.deps.runtime.time.now(),
          `job ${launchRecord.jobId}`,
        ),
      },
    );
    try {
      writeResultArtifact(
        this.deps.runtime.storage,
        this.deps.runtime.paths.coral.exports.jobsRoot,
        launchRecord.jobId,
        interruptedReport,
      );
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifact failed for ${launchRecord.jobId}: ${String(error)}`);
    }
    this.deps.abortRegistry.remove(launchRecord.jobId);
    this.deps.launchAdmission.releaseLaunch(
      launchRecord.jobId,
      this.deps.jobPools.get(launchRecord.jobId) ?? launchRecord.pool,
    );
    this.deps.jobPools.delete(launchRecord.jobId);
    await this.finalizeSessionContinuityMutation(
      launchRecord.provider,
      launchRecord.sessionId,
      launchRecord.jobId,
      mutation,
    );
  }

  private async probeInterruptedAppServerContinuity(options: {
    launchRecord: ProviderRecoveryLaunch;
    runtimeRecord: AppServerRuntime;
    prepared: BoundProviderPreparedExecution;
    recovery: BoundProviderRecovery;
    continuity: ProviderContinuityBlob;
    recoveryConversationRef: string | undefined;
  }): Promise<{ mutation: SessionContinuityMutation; probeOutcome: InterruptedProbeOutcome }> {
    const { launchRecord, runtimeRecord, prepared, recovery, continuity, recoveryConversationRef } = options;
    const appServer = prepared.appServer;
    if (appServer === undefined) {
      throw new Error(`Provider '${launchRecord.provider}' has no bound app-server capability.`);
    }
    const probe = recovery.probe;
    if (probe === undefined) {
      throw new Error(`Provider '${launchRecord.provider}' has no interrupted recovery probe.`);
    }
    const spec = appServer.buildServerSpec(continuity, { storage: this.deps.runtime.storage });

    try {
      const liveServer =
        spec.shared !== true && runtimeRecord.providerMeta.leaseState === 'acquired'
          ? await this.deps.providerHostManager.borrowLiveServer(spec, {
              serverGeneration: runtimeRecord.providerMeta.serverGeneration,
            })
          : null;
      const lease = liveServer ? this.createAttachedProviderServerLease(liveServer) : await this.requestServer(spec);
      try {
        const probeResult = await probe(lease, continuity);
        return {
          probeOutcome: probeResult.resumable ? 'verified' : 'missing',
          mutation: recovery.finalizeInterrupted(probeResult, continuity, {
            preservedConversationRef: recoveryConversationRef,
          }),
        };
      } finally {
        if (!liveServer) lease.release();
      }
    } catch (error: unknown) {
      backendLog.error(`Probe failed for ${launchRecord.jobId}: ${errorMessage(error)}`);
      return {
        probeOutcome: 'unavailable',
        mutation: recovery.finalizeInterrupted({ resumable: false, updatedContinuity: continuity }, continuity, {
          preservedConversationRef: recoveryConversationRef,
        }),
      };
    }
  }

  private async decideInterruptedAppServerRecovery(options: {
    launchRecord: ProviderRecoveryLaunch;
    runtimeRecord: AppServerRuntime;
    session: ProviderRecoverySession;
    bound: BoundProvider;
  }): Promise<{
    mutation: SessionContinuityMutation;
    probeOutcome: InterruptedProbeOutcome;
    recoveryConversationRef: string | undefined;
  }> {
    const { launchRecord, runtimeRecord, session, bound } = options;
    const request = toProviderRequest(launchRecord, session.conversationRef);
    const prepared = this.prepareRecoveryExecution(bound, session, request, launchRecord.jobId);
    const appServer = prepared.appServer;
    const recovery = bound.recovery;
    const persistedConversationRef = readContinuityRef(session.conversationRef);
    const recoveryConversationRef = persistedConversationRef;
    const continuity = this.sessionProviderContinuity(session);

    if (appServer === undefined) {
      throw new Error(
        `Provider '${launchRecord.provider}' produced an app-server runtime without an app-server capability.`,
      );
    }
    if (recovery === undefined) {
      throw new Error(`Provider '${launchRecord.provider}' has no interrupted app-server recovery capability.`);
    }
    if (runtimeRecord.providerMeta.leaseState === 'waiting') {
      const mutation = recovery.finalizeInterrupted(
        {
          resumable: persistedConversationRef !== undefined || continuity !== undefined,
          ...(continuity === undefined ? {} : { updatedContinuity: continuity }),
        },
        continuity,
        { preservedConversationRef: persistedConversationRef },
      );
      return { mutation, probeOutcome: 'waiting', recoveryConversationRef };
    }
    if (recovery.probe === undefined) {
      return {
        ...(await this.recoverInterruptedContinuityFromArtifacts({
          launchRecord,
          runtimeRecord,
          session,
          recovery,
          continuity,
          preservedConversationRef: recoveryConversationRef,
        })),
        recoveryConversationRef,
      };
    }
    if (continuity !== undefined) {
      return {
        ...(await this.probeInterruptedAppServerContinuity({
          launchRecord,
          runtimeRecord,
          prepared,
          recovery,
          continuity,
          recoveryConversationRef,
        })),
        recoveryConversationRef,
      };
    }
    return {
      ...(await this.recoverInterruptedContinuityFromArtifacts({
        launchRecord,
        runtimeRecord,
        session,
        recovery,
        continuity,
        preservedConversationRef: recoveryConversationRef,
      })),
      recoveryConversationRef,
    };
  }

  async finalizeInterruptedAppServerJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: AppServerRuntime,
    options: { reason: InterruptedAppServerReason },
  ): Promise<void> {
    const { launchRecord, session, boundProvider } = authority;
    const status = this.deps.progressStore.readStatus(launchRecord.jobId);
    if (!status || isTerminalPhase(status.phase)) {
      if (status && options.reason === 'handoff') {
        backendLog.warn(`skipping finalize for already-terminal job ${launchRecord.jobId} during handoff recovery`);
      }
      return;
    }

    if (boundProvider.recovery === undefined) {
      recordJobRecoveryFaultTerminal(
        this.deps.progressStore,
        {
          kind: 'recovery_parse_failed',
          cause: { message: `Bound provider '${boundProvider.name}' does not expose app-server recovery capability.` },
        },
        {
          jobId: launchRecord.jobId,
          sessionId: session.sessionId,
          namespace: status.backendNamespace,
          project: status.projectRoot,
        },
        {
          content: '',
          durationMs: elapsedDurationMs(
            runtimeRecord.startTime,
            this.deps.runtime.time.now(),
            `job ${launchRecord.jobId}`,
          ),
        },
      );
      const persistedPayload = this.deps.progressStore.readTerminalProjection(launchRecord.jobId);
      if (persistedPayload === null) {
        throw new Error(`Unsupported app-server recovery did not record a terminal payload for ${launchRecord.jobId}.`);
      }
      this.completeRecoveredJob(launchRecord.jobId, session.sessionId, persistedPayload, 'error', {
        pool: launchRecord.pool,
      });
      return;
    }

    const { mutation, probeOutcome, recoveryConversationRef } = await this.decideInterruptedAppServerRecovery({
      launchRecord,
      runtimeRecord,
      session,
      bound: boundProvider,
    });

    await this.materializeInterruptedAppServerRecovery({
      launchRecord,
      runtimeRecord,
      status,
      reason: options.reason,
      probeOutcome,
      mutation,
      recoveryConversationRef,
    });
  }

  async recoverQueuedJob(authority: ProviderRecoveryAuthority): Promise<string> {
    const { launchRecord, session, boundProvider } = authority;
    const pool = launchRecord.pool;
    const jobId = launchRecord.jobId;

    this.deps.jobPools.set(jobId, pool);

    const queuedHandle = this.deps.launchRecovery.restoreQueuedLaunch(
      jobId,
      launchRecord.provider,
      launchRecord.owner,
      pool,
    );
    this.deps.abortRegistry.register(jobId, () => {
      queuedHandle.cancel();
    });

    this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

    this.deps.launchOrchestrator.runRecoveredQueuedJob(
      boundProvider,
      launchRecord,
      queuedHandle,
      pool,
      this.recoveryChildEnv(session, jobId),
    );

    return jobId;
  }

  async recordRecoveredArtifactHandles(
    sessionId: string,
    input: {
      readonly jobId: string;
      readonly handles: readonly ProviderArtifactHandleInput[];
    },
  ): Promise<{ readonly ok: true; readonly nextVersion: number } | { readonly ok: false }> {
    const session = this.deps.sessionManager.readById(sessionId, { forceFresh: true });
    if (!session) {
      return { ok: false };
    }

    let expectedVersion = session.version;
    for (const artifact of input.handles) {
      const recorded = await this.deps.sessionManager.recordArtifactHandleAtomic(sessionId, {
        expectedActiveJobId: input.jobId,
        expectedVersion,
        handle: artifact.handle,
        identity: artifact.identity,
        sourceJobId: input.jobId,
      });
      if (!recorded.ok) {
        return { ok: false };
      }
      expectedVersion = recorded.nextVersion;
    }

    return { ok: true, nextVersion: expectedVersion };
  }

  async adoptRunningJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: JobRuntime,
  ): Promise<{ adopted: boolean; cleanup: () => void }> {
    const { launchRecord } = authority;
    const pool = launchRecord.pool;
    const jobId = launchRecord.jobId;

    if (!isDurableCliRuntime(runtimeRecord)) {
      throw new Error(`Unsupported runtime transport for adoptRunningJob(${jobId}): ${runtimeRecord.transport}`);
    }
    this.deps.jobPools.set(jobId, pool);

    this.deps.launchRecovery.restoreActiveLaunch(jobId, launchRecord.provider, launchRecord.owner, pool);
    this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

    const pid = runtimeRecord.pid;
    this.deps.abortRegistry.register(jobId, () => {
      this.deps.runtime.process.kill(pid, 'SIGTERM');
    });

    let cleaned = false;
    return {
      adopted: true,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        this.deps.abortRegistry.remove(jobId);
        this.deps.launchAdmission.releaseLaunch(jobId, pool);
        this.deps.jobPools.delete(jobId);
      },
    };
  }

  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions & { pool: LaunchPool; sessionContinuity?: ContinuitySnapshot | null },
  ): void {
    const currentStatus = this.deps.progressStore.readStatus(jobId);
    if (!currentStatus || !isTerminalPhase(currentStatus.phase)) {
      this.deps.launchOrchestrator.writeJobTerminal(jobId, sessionId, result, phase, {
        diagnostics: options.diagnostics,
      });
    }
    try {
      writeResultArtifact(
        this.deps.runtime.storage,
        this.deps.runtime.paths.coral.exports.jobsRoot,
        jobId,
        result.content,
      );
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifact failed for ${jobId}: ${String(error)}`);
    }
    this.deps.abortRegistry.remove(jobId);
    this.deps.launchAdmission.releaseLaunch(jobId, options.pool);
    this.deps.jobPools.delete(jobId);

    const continuity = options.sessionContinuity ?? null;
    const continuityConversationRef = readContinuityRef(continuity?.conversationRef);
    if (continuity?.providerContinuity) {
      this.deps.sessionManager.checkpointProviderContinuity(sessionId, {
        providerContinuity: continuity.providerContinuity,
        ...(continuityConversationRef !== undefined ? { conversationRef: continuityConversationRef } : {}),
      });
    } else if (continuityConversationRef !== undefined) {
      this.deps.sessionManager.setConversationRef(sessionId, continuityConversationRef);
    }
    if (continuity && !continuity.resumable) {
      this.deps.sessionManager.setNonResumable(sessionId);
    }
    this.deps.sessionManager.releaseJob(sessionId, jobId);
  }

  private createAttachedProviderServerLease(attachment: ExecutionProviderServerAttachment): ProviderServerLease {
    return {
      rpc: attachment.rpc,
      subscribe: attachment.subscribe,
      release: () => {},
      closed: attachment.closed,
    };
  }

  private sessionProviderContinuity(
    session: Pick<ProviderRecoverySession, 'providerContinuity'>,
  ): ProviderContinuityBlob | undefined {
    return session.providerContinuity ?? undefined;
  }

  private writeAppServerRuntimeRecord(
    jobId: string,
    providerName: string,
    update: Partial<AppServerRuntime['providerMeta']>,
  ): void {
    const current = this.deps.progressStore.readRuntimeProjection(jobId);
    const appRuntime = isAppServerRuntime(current) ? current : null;
    const record: AppServerRuntime = {
      transport: 'app-server',
      startTime: appRuntime?.startTime ?? nowIsoString(this.deps.runtime.time),
      providerMeta: {
        provider: providerName,
        leaseState: update.leaseState ?? appRuntime?.providerMeta.leaseState ?? 'waiting',
        serverGeneration: update.serverGeneration ?? appRuntime?.providerMeta.serverGeneration,
        transportMode: update.transportMode ?? appRuntime?.providerMeta.transportMode,
      },
    };
    this.deps.progressStore.appendRuntimeStarted(jobId, record);
  }

  private async finalizeSessionContinuityMutation(
    providerName: string,
    sessionId: string,
    jobId: string,
    mutation: SessionContinuityMutation,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < FINALIZE_CONTINUITY_MAX_RETRIES; attempt += 1) {
      const session = this.deps.sessionManager.get(providerName, sessionId);
      if (!session || session.activeJobId !== jobId) {
        return false;
      }

      const finalized = await this.deps.sessionManager.finalizeJobContinuityAtomic(sessionId, {
        expectedActiveJobId: jobId,
        expectedVersion: session.version,
        mutation,
      });
      if (finalized) {
        return true;
      }
    }

    this.deps.sessionManager.releaseJob(sessionId, jobId);
    return false;
  }
}
