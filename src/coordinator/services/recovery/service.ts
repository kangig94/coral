import type {
  ProviderExecutionContext,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderServerLease,
  ProviderServerSpec,
} from '../../../providers/contract.js';
import { join } from 'node:path';
import { buildProviderExecutionContext } from '../../../providers/execution-context.js';
import { readContinuityRef, type ProviderContinuityBlob } from '../../../sessions/continuity.js';
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
import type { SessionAuthority, SessionEntry } from '../../../sessions/entry.js';
import { nowIsoString } from '../../../infra/time.js';
import type { ProviderBindingCatalog } from '../../../providers/catalog.js';
import type { ProviderBindingFailure } from '../../../providers/contracts/binding.js';
import type { ProviderArtifactHandleInput } from '../../../providers/contract.js';
import type { ExecutionProviderServerAttachment, ExecutionProviderHostManager } from '../../contracts.js';
import type { JobAdmissionPort, JobLaunchRecoveryPort, LaunchPool } from '../../../jobs/contracts/admission.js';
import type { JobProgressStore, TerminalWriteOptions } from '../../../jobs/contracts/job-store.js';
import type { SessionRecoveryPort } from '../../../sessions/contracts.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ProviderCredentialSourceRef } from '../../../infra/provider-credential-sources.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { RecoveredJobLifecyclePort } from '../../../jobs/contracts/job-runner.js';
import { toProviderRequest } from '../../../jobs/provider-request.js';
import { CONTEXT_ENV_KEY } from '../../../transport/context-profile.js';
import {
  FINALIZE_CONTINUITY_MAX_RETRIES,
  buildInterruptedAppServerReport,
  isProviderContinuityBlob,
} from '../execution-policies.js';
import type {
  InterruptedAppServerReason,
  InterruptedProbeOutcome,
} from '../../../jobs/reconcile/interrupted-reason.js';
import { recordSessionInterruptedTerminal } from '../terminal-materializer.js';
import {
  CHILD_PRINCIPAL_CAPABILITIES,
  CORAL_CHILD_PRINCIPAL_HANDLE,
  type ChildPrincipalRegistry,
} from '../../child-principal-registry.js';
import type { Principal } from '../../../security/principal.js';

type ProviderLaunchRecord = JobLaunch & {
  sessionId: string;
  provider: string;
  jobKind: Exclude<JobLaunch['jobKind'], 'kb'>;
};

type ProviderSessionEntry = SessionEntry & {
  sessionAuthority: Extract<SessionAuthority, { kind: 'provider' }>;
};

function requireProviderLaunchRecord(
  launchRecord: JobLaunch,
  operation: string,
): asserts launchRecord is ProviderLaunchRecord {
  if (launchRecord.jobKind === 'kb' || launchRecord.sessionId === null || launchRecord.provider === null) {
    throw new Error(`${operation} requires a provider launch record.`);
  }
}

function readClaudeTransportMode(spec: ProviderServerSpec): string | undefined {
  if (spec.provider !== 'claude') {
    return undefined;
  }
  const value = spec.env?.[CONTEXT_ENV_KEY.claudeTransport];
  return value === undefined || value.length === 0 ? undefined : value;
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
    options?: { jobId?: string; signal?: AbortSignal; providerMeta?: Record<string, unknown> },
  ) => Promise<ProviderServerLease>;
}

export class RecoveryService {
  private readonly deps: RecoveryServiceDeps;
  constructor(deps: RecoveryServiceDeps) {
    this.deps = deps;
  }

  private providerContext(
    session: SessionEntry,
    source: ProviderCredentialSourceRef,
    request: ProviderRequest,
    jobId: string,
  ): ProviderExecutionContext {
    const protectedEnv = this.recoveryChildEnv(session, jobId);
    return buildProviderExecutionContext({
      source,
      request,
      baseEnv: this.deps.runtime.env.fullSnapshot(),
      protectedEnv,
      platform: this.deps.runtime.env.platform(),
    });
  }

  private recoveryChildEnv(session: SessionEntry, jobId: string): Readonly<Record<string, string>> {
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
    | { ok: true; session: ProviderSessionEntry; source: ProviderCredentialSourceRef }
    | { ok: false; failure: ProviderBindingFailure }
  > {
    const provider = launchRecord.provider;
    if (provider === null || launchRecord.sessionId === null) {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider: provider ?? 'unknown' } };
    }
    let session: SessionEntry | null;
    try {
      session = this.deps.sessionManager.readById(launchRecord.sessionId, { forceFresh: true });
    } catch {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    }
    if (session === null) return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    if (
      session?.sessionAuthority.kind !== 'provider' ||
      session.provider !== launchRecord.provider ||
      session.sessionAuthority.binding.provider !== launchRecord.provider
    ) {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    }
    const binding = this.deps.providerRegistry.rehydrateBinding(session.sessionAuthority.binding);
    if (!binding.ok) return { ok: false, failure: binding.failure };
    if (binding.value.provider !== provider) {
      return { ok: false, failure: { reason: 'invalid-persisted-binding', provider } };
    }
    const readiness = await binding.value.readiness('recovery', this.deps.runtime.storage);
    if (!readiness.ok) return { ok: false, failure: readiness.failure };
    return { ok: true, session: session as ProviderSessionEntry, source: binding.value.credentialSource() };
  }

  private failBindingIntegrity(launchRecord: JobLaunch, failure: ProviderBindingFailure): void {
    if (launchRecord.sessionId === null) return;
    const message = this.deps.providerRegistry.renderBindingFailure(failure);
    this.completeRecoveredJob(
      launchRecord.jobId,
      launchRecord.sessionId,
      {
        content: message,
        outcome: {
          kind: 'job_fault',
          fault: { kind: 'provider_binding', provider: failure.provider, reason: failure.reason, message },
        },
      },
      'error',
    );
  }

  async validateProviderRecoveryAuthority(launchRecord: JobLaunch): Promise<boolean> {
    return (await this.providerCredentialSourceForRecovery(launchRecord)) !== null;
  }

  async providerCredentialSourceForRecovery(launchRecord: JobLaunch): Promise<ProviderCredentialSourceRef | null> {
    requireProviderLaunchRecord(launchRecord, 'validateProviderRecoveryAuthority');
    const result = await this.readProviderSession(launchRecord);
    if (result.ok) return result.source;
    this.failBindingIntegrity(launchRecord, result.failure);
    return null;
  }

  private requestServer(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal; providerMeta?: Record<string, unknown> },
  ): Promise<ProviderServerLease> {
    return this.deps.acquireServer ? this.deps.acquireServer(spec, options) : this.acquireServer(spec, options);
  }

  async acquireServer(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal; providerMeta?: Record<string, unknown> },
  ): Promise<ProviderServerLease> {
    const claudeTransport = readClaudeTransportMode(spec);
    const rawConversationRef = options?.providerMeta?.conversationRef;
    const conversationRef = typeof rawConversationRef === 'string' ? readContinuityRef(rawConversationRef) : undefined;
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, {
        leaseState: 'waiting',
        ...(conversationRef === undefined ? {} : { conversationRef }),
        ...(claudeTransport === undefined ? {} : { claudeTransport }),
      });
    }

    const lease = await this.deps.providerHostManager.acquireServer(spec, { signal: options?.signal });
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, {
        leaseState: 'acquired',
        serverGeneration: lease.generation,
        ...(conversationRef === undefined ? {} : { conversationRef }),
        ...(claudeTransport === undefined ? {} : { claudeTransport }),
      });
    }
    return lease;
  }

  async interruptAppServerJob(launchRecord: JobLaunch, runtimeRecord: AppServerRuntime): Promise<void> {
    requireProviderLaunchRecord(launchRecord, 'interruptAppServerJob');
    const providerEntry = this.deps.providerRegistry.get(launchRecord.provider);
    const appServer = providerEntry?.appServer;
    if (!appServer?.interrupt) {
      return;
    }
    const storedSession = await this.readProviderSession(launchRecord);
    if (!storedSession.ok) {
      this.failBindingIntegrity(launchRecord, storedSession.failure);
      return;
    }
    const session = storedSession.session;
    const continuity = this.resolveAppServerContinuity(runtimeRecord, session);
    if (!continuity) {
      return;
    }

    const request = toProviderRequest(launchRecord);
    const spec = appServer.buildServerSpec(
      request,
      continuity,
      { storage: this.deps.runtime.storage },
      this.providerContext(session, storedSession.source, request, launchRecord.jobId),
    );
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
    launchRecord: ProviderLaunchRecord;
    runtimeRecord: AppServerRuntime;
    session: ProviderSessionEntry;
    source: ProviderCredentialSourceRef;
    recovery: ProviderRecoveryContract;
    continuity: ProviderContinuityBlob | undefined;
    preservedConversationRef: string | undefined;
  }): Promise<{ mutation: SessionContinuityMutation; probeOutcome: InterruptedProbeOutcome }> {
    const { launchRecord, runtimeRecord, session, source, recovery, continuity, preservedConversationRef } = options;
    const jobDir = this.deps.progressStore.jobDir(launchRecord.jobId);
    const artifactResult = await recovery.finalizeFromArtifacts({
      source,
      stdoutPath: join(jobDir, 'stdout'),
      stderrPath: join(jobDir, 'stderr'),
      exitCode: null,
      signal: null,
      providerMeta: {
        ...runtimeRecord.providerMeta,
      },
      fallbackConversationRef: preservedConversationRef,
      knownArtifactHandles: session.artifactHandles
        .filter((artifact) => artifact.provider === launchRecord.provider)
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
        provider: launchRecord.provider,
        handles: artifactResult.artifactHandles,
      });
    }
    const recoveredConversationRef =
      artifactResult.continuity === undefined
        ? preservedConversationRef
        : readContinuityRef(artifactResult.continuity.conversationRef);
    const artifactResumable = artifactResult.continuity?.resumable ?? recoveredConversationRef !== undefined;
    const recoveredProviderContinuity = artifactResult.continuity?.providerContinuity ?? continuity;
    const mutation =
      (continuity === undefined
        ? undefined
        : recovery.finalizeInterrupted?.(
            {
              resumable: artifactResumable,
              updatedContinuity: recoveredProviderContinuity,
            },
            continuity,
            { preservedConversationRef: recoveredConversationRef },
          )) ??
      (recoveredConversationRef !== undefined
        ? {
            kind: 'set_resumable' as const,
            conversationRef: recoveredConversationRef,
            providerContinuity: recoveredProviderContinuity,
          }
        : { kind: 'clear_non_resumable' as const, providerContinuity: recoveredProviderContinuity });
    return {
      mutation,
      probeOutcome: artifactResumable ? 'verified' : 'missing',
    };
  }

  private async materializeInterruptedAppServerRecovery(options: {
    launchRecord: ProviderLaunchRecord;
    status: JobStatus;
    reason: InterruptedAppServerReason;
    probeOutcome: InterruptedProbeOutcome;
    mutation: SessionContinuityMutation;
    recoveryConversationRef: string | undefined;
  }): Promise<void> {
    const { launchRecord, status, reason, probeOutcome, mutation, recoveryConversationRef } = options;
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
      { content: interruptedReport },
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
      (this.deps.jobPools.get(launchRecord.jobId) ?? launchRecord.pool ?? 'default') as LaunchPool,
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
    launchRecord: ProviderLaunchRecord;
    runtimeRecord: AppServerRuntime;
    session: ProviderSessionEntry;
    source: ProviderCredentialSourceRef;
    appServer: ProviderAppServerContract;
    recovery: ProviderRecoveryContract;
    continuity: ProviderContinuityBlob;
    recoveryConversationRef: string | undefined;
  }): Promise<{ mutation: SessionContinuityMutation; probeOutcome: InterruptedProbeOutcome }> {
    const { launchRecord, runtimeRecord, session, source, appServer, recovery, continuity, recoveryConversationRef } =
      options;
    const probe = recovery.probe;
    if (probe === undefined) {
      throw new Error(`Provider '${launchRecord.provider}' has no interrupted recovery probe.`);
    }
    const request = toProviderRequest(launchRecord);
    const spec = appServer.buildServerSpec(
      request,
      continuity,
      { storage: this.deps.runtime.storage },
      this.providerContext(session, source, request, launchRecord.jobId),
    );

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
          mutation:
            recovery.finalizeInterrupted?.(probeResult, continuity, {
              preservedConversationRef: recoveryConversationRef,
            }) ??
            (recoveryConversationRef !== undefined
              ? { kind: 'set_resumable', conversationRef: recoveryConversationRef }
              : { kind: 'preserve' }),
        };
      } finally {
        if (!liveServer) lease.release();
      }
    } catch (error: unknown) {
      backendLog.error(`Probe failed for ${launchRecord.jobId}: ${errorMessage(error)}`);
      return {
        probeOutcome: 'unavailable',
        mutation:
          recovery.finalizeInterrupted?.({ resumable: false, updatedContinuity: continuity }, continuity, {
            preservedConversationRef: recoveryConversationRef,
          }) ??
          (recoveryConversationRef !== undefined
            ? { kind: 'set_resumable', conversationRef: recoveryConversationRef }
            : { kind: 'preserve' }),
      };
    }
  }

  private async decideInterruptedAppServerRecovery(options: {
    launchRecord: ProviderLaunchRecord;
    runtimeRecord: AppServerRuntime;
    session: ProviderSessionEntry;
    source: ProviderCredentialSourceRef;
  }): Promise<{
    mutation: SessionContinuityMutation;
    probeOutcome: InterruptedProbeOutcome;
    recoveryConversationRef: string | undefined;
  }> {
    const { launchRecord, runtimeRecord, session, source } = options;
    const providerEntry = this.deps.providerRegistry.get(launchRecord.provider);
    const appServer = providerEntry?.appServer;
    const recovery = providerEntry?.recovery;
    const persistedConversationRef =
      readContinuityRef(session.conversationRef) ?? readContinuityRef(launchRecord.request.conversationRef);
    const recoveryConversationRef =
      persistedConversationRef ?? readContinuityRef(runtimeRecord.providerMeta.conversationRef);
    const continuity = this.resolveAppServerContinuity(runtimeRecord, session);

    if (!appServer || !recovery) {
      return {
        probeOutcome: 'waiting',
        mutation:
          persistedConversationRef === undefined
            ? { kind: 'clear_non_resumable' }
            : { kind: 'set_resumable', conversationRef: persistedConversationRef },
        recoveryConversationRef,
      };
    }
    if (runtimeRecord.providerMeta.leaseState === 'waiting') {
      const mutation =
        (continuity === undefined
          ? undefined
          : recovery.finalizeInterrupted?.(
              {
                resumable: persistedConversationRef !== undefined || continuity !== undefined,
                updatedContinuity: continuity,
              },
              continuity,
              { preservedConversationRef: persistedConversationRef },
            )) ??
        (persistedConversationRef === undefined
          ? { kind: 'clear_non_resumable' as const }
          : { kind: 'set_resumable' as const, conversationRef: persistedConversationRef });
      return { mutation, probeOutcome: 'waiting', recoveryConversationRef };
    }
    if (recovery.probe === undefined) {
      return {
        ...(await this.recoverInterruptedContinuityFromArtifacts({
          launchRecord,
          runtimeRecord,
          session,
          source,
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
          session,
          source,
          appServer,
          recovery,
          continuity,
          recoveryConversationRef,
        })),
        recoveryConversationRef,
      };
    }
    return {
      probeOutcome: 'waiting',
      mutation:
        persistedConversationRef === undefined
          ? { kind: 'clear_non_resumable' }
          : { kind: 'set_resumable', conversationRef: persistedConversationRef },
      recoveryConversationRef,
    };
  }

  async finalizeInterruptedAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
    options: { reason: InterruptedAppServerReason },
  ): Promise<void> {
    requireProviderLaunchRecord(launchRecord, 'finalizeInterruptedAppServerJob');
    const status = this.deps.progressStore.readStatus(launchRecord.jobId);
    if (!status || isTerminalPhase(status.phase)) {
      // Cross-version partial-state preservation: a pre-PR daemon wrote a
      // terminal record before crashing mid-finalizer. The replacement
      // recognizes it as terminal and does not re-finalize. Warn surfaces
      // this path for operator visibility without re-running the durable
      // mutation sequence.
      if (status && options.reason === 'handoff') {
        backendLog.warn(
          `skipping finalize for already-terminal job ${launchRecord.jobId} during handoff recovery — likely cross-version partial-state from pre-PR daemon`,
        );
      }
      return;
    }

    const storedSession = await this.readProviderSession(launchRecord);
    if (!storedSession.ok) {
      this.failBindingIntegrity(launchRecord, storedSession.failure);
      return;
    }
    const session = storedSession.session;
    const { mutation, probeOutcome, recoveryConversationRef } = await this.decideInterruptedAppServerRecovery({
      launchRecord,
      runtimeRecord,
      session,
      source: storedSession.source,
    });

    await this.materializeInterruptedAppServerRecovery({
      launchRecord,
      status,
      reason: options.reason,
      probeOutcome,
      mutation,
      recoveryConversationRef,
    });
  }

  async recoverQueuedJob(launchRecord: JobLaunch): Promise<string> {
    requireProviderLaunchRecord(launchRecord, 'recoverQueuedJob');
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;
    const sessionResult = await this.readProviderSession(launchRecord);
    if (!sessionResult.ok) {
      this.failBindingIntegrity(launchRecord, sessionResult.failure);
      return jobId;
    }
    const session = sessionResult.session;

    this.deps.jobPools.set(jobId, pool);

    const queuedHandle = this.deps.launchRecovery.restoreQueuedLaunch(jobId, launchRecord.provider, pool);
    this.deps.abortRegistry.register(jobId, () => {
      queuedHandle.cancel();
    });

    this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

    const provider = this.deps.providerRegistry.get(launchRecord.provider);
    if (provider) {
      this.deps.launchOrchestrator.runRecoveredQueuedJob(
        provider,
        launchRecord,
        queuedHandle,
        pool,
        this.recoveryChildEnv(session, jobId),
      );
    }

    return jobId;
  }

  async recordRecoveredArtifactHandles(
    sessionId: string,
    input: {
      readonly jobId: string;
      readonly provider: string;
      readonly handles: readonly ProviderArtifactHandleInput[];
    },
  ): Promise<{ readonly ok: true; readonly nextVersion: number } | { readonly ok: false }> {
    const session = this.deps.sessionManager.get(input.provider, sessionId);
    if (!session) {
      return { ok: false };
    }

    let expectedVersion = session.version;
    for (const artifact of input.handles) {
      const recorded = await this.deps.sessionManager.recordArtifactHandleAtomic(sessionId, {
        expectedActiveJobId: input.jobId,
        expectedVersion,
        provider: input.provider,
        handle: artifact.handle,
        identity: artifact.identity,
        sourceJobId: artifact.sourceJobId ?? input.jobId,
      });
      if (!recorded.ok) {
        return { ok: false };
      }
      expectedVersion = recorded.nextVersion;
    }

    return { ok: true, nextVersion: expectedVersion };
  }

  async adoptRunningJob(
    launchRecord: JobLaunch,
    runtimeRecord: JobRuntime,
  ): Promise<{ adopted: boolean; cleanup: () => void }> {
    requireProviderLaunchRecord(launchRecord, 'adoptRunningJob');
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;

    if (!isDurableCliRuntime(runtimeRecord)) {
      throw new Error(`Unsupported runtime transport for adoptRunningJob(${jobId}): ${runtimeRecord.transport}`);
    }
    const sessionResult = await this.readProviderSession(launchRecord);
    if (!sessionResult.ok) {
      try {
        const signalled = this.deps.runtime.process.kill(runtimeRecord.pid, 'SIGTERM');
        if (!signalled) {
          backendLog.warn(`Could not signal provider process ${runtimeRecord.pid} for rejected recovery ${jobId}.`);
        }
      } catch (error: unknown) {
        backendLog.warn(
          `Could not signal provider process ${runtimeRecord.pid} for rejected recovery ${jobId}: ${errorMessage(error)}`,
        );
      }
      this.failBindingIntegrity(launchRecord, sessionResult.failure);
      return { adopted: false, cleanup: () => {} };
    }

    this.deps.jobPools.set(jobId, pool);

    this.deps.launchRecovery.restoreActiveLaunch(jobId, launchRecord.provider, pool);
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
    options?: TerminalWriteOptions,
  ): void {
    const currentStatus = this.deps.progressStore.readStatus(jobId);
    if (!currentStatus || !isTerminalPhase(currentStatus.phase)) {
      this.deps.launchOrchestrator.writeJobTerminal(jobId, sessionId, result, phase, {
        ...options,
        continuity: options?.continuity ?? null,
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
    const pool = this.deps.jobPools.get(jobId) ?? 'default';
    this.deps.launchAdmission.releaseLaunch(jobId, pool);
    this.deps.jobPools.delete(jobId);

    const continuity = options?.continuity ?? null;
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

  private resolveAppServerContinuity(
    runtimeRecord: AppServerRuntime,
    session?: Pick<SessionEntry, 'providerContinuity'> | null,
  ): ProviderContinuityBlob | undefined {
    if (isProviderContinuityBlob(runtimeRecord.providerMeta.providerContinuity)) {
      return runtimeRecord.providerMeta.providerContinuity;
    }
    if (isProviderContinuityBlob(session?.providerContinuity)) {
      return session.providerContinuity;
    }
    return undefined;
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
        providerContinuity: update.providerContinuity ?? appRuntime?.providerMeta.providerContinuity,
        conversationRef: update.conversationRef ?? appRuntime?.providerMeta.conversationRef,
        claudeTransport: update.claudeTransport ?? appRuntime?.providerMeta.claudeTransport,
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
