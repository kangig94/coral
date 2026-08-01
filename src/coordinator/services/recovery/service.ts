import type { ProviderRequest } from '../../../providers/contract.js';
import type { ProviderContinuityBlob } from '../../../sessions/continuity.js';
import { backendLog } from '../../../infra/backend-log.js';
import type { AppServerRuntime, JobLaunch, JobRuntime, JobTerminal, JobTerminalInput } from '../../../jobs/records.js';
import { isTerminalPhase, type JobPhase } from '../../../jobs/phase.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from '../../../runtime/durable-runtime.js';
import { providerSessionProvider, type ProviderSession } from '../../../sessions/entry.js';
import type { ProviderBindingCatalog } from '../../../providers/catalog.js';
import type { ProviderBindingFailure } from '../../../providers/contracts/binding.js';
import type {
  JobAdmissionPort,
  JobLaunchRecoveryPort,
  LaunchPool,
  QueuedHandle,
} from '../../../jobs/contracts/admission.js';
import type { JobProgressStore, TerminalWriteOptions } from '../../../jobs/contracts/job-store.js';
import type { SessionJobClaimReleaseResult, SessionRecoveryPort } from '../../../sessions/contracts.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { BoundProvider, BoundProviderHostPreparationInput } from '../../../providers/bound-provider-contract.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { RecoveredJobLifecyclePort } from '../../../jobs/contracts/job-runner.js';
import type {
  ProviderRecoveryAuthority,
  ProviderRecoveryAuthorityCapture,
  ProviderRecoveryLaunch,
  ProviderRecoverySession,
} from '../../../jobs/reconcile/contracts.js';
import { toProviderRequest } from '../../../jobs/provider-request.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import { CHILD_PRINCIPAL_CAPABILITIES, type ChildPrincipalRegistry } from '../../child-principal-registry.js';
import { CORAL_CHILD_PRINCIPAL_HANDLE } from '../../../security/child-principal-env.js';
import type { Principal } from '../../../security/principal.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import { snapshotProviderRecoveryAuthority } from './authority-snapshot.js';
import { planInterruptedAppServerRecovery, planInterruptedDurableRecovery } from './interrupted-plan.js';
import { performInterruptedAppServerRecovery, performInterruptedDurableRecovery } from './interrupted-performer.js';
import { finalizeInterruptedAppServerRecovery, finalizeInterruptedDurableRecovery } from './interrupted-finalizer.js';

function requireProviderLaunchRecord(
  launchRecord: JobLaunch,
  operation: string,
): asserts launchRecord is ProviderRecoveryLaunch {
  if (launchRecord.jobKind !== 'provider' || launchRecord.sessionId === null || launchRecord.provider === null) {
    throw new Error(`${operation} requires a provider launch record.`);
  }
}

export interface RecoveryServiceDeps {
  runtime: Runtime;
  sessionManager: SessionRecoveryPort;
  abortRegistry: JobAbortRegistryPort;
  backendNamespace: string;
  bundleHash: string;
  progressStore: JobProgressStore;
  launchAdmission: Pick<JobAdmissionPort, 'releaseLaunch'>;
  launchRecovery: JobLaunchRecoveryPort;
  providerRegistry: ProviderBindingCatalog;
  jobPools: Map<string, LaunchPool>;
  launchOrchestrator: RecoveredJobLifecyclePort;
  childPrincipalRegistry: ChildPrincipalRegistry;
  parentPrincipal: Principal;
}

export class RecoveryService {
  private readonly deps: RecoveryServiceDeps;
  constructor(deps: RecoveryServiceDeps) {
    this.deps = deps;
  }

  private boundHostInput(
    session: ProviderRecoverySession,
    request: ProviderRequest,
  ): BoundProviderHostPreparationInput {
    return {
      request,
      persistedContinuity: session.providerContinuity ?? undefined,
      baseEnv: this.deps.runtime.env.fullSnapshot(),
      platform: this.deps.runtime.env.platform(),
      storage: this.deps.runtime.storage,
    };
  }

  private queuedRecoveryChildEnv(session: ProviderRecoverySession, jobId: string): Readonly<Record<string, string>> {
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

  private async readProviderSession(launchRecord: JobLaunch): Promise<
    | {
        ok: true;
        session: ProviderSession;
        bound: BoundProvider;
        continuity: ProviderContinuityBlob | undefined;
      }
    | { ok: false; failure: ProviderBindingFailure }
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
    const continuity = binding.value.decodeContinuity(session.providerContinuity);
    if (!continuity.ok) return { ok: false, failure: continuity.failure };
    const readiness = await binding.value.readiness('recovery', this.deps.runtime.storage);
    if (!readiness.ok) return { ok: false, failure: readiness.failure };
    return { ok: true, session, bound: binding.value, continuity: continuity.value };
  }

  finalizeProviderRecoveryBindingFailure(
    launchRecord: JobLaunch,
    failure: ProviderBindingFailure,
  ): SessionJobClaimReleaseResult {
    requireProviderLaunchRecord(launchRecord, 'finalizeProviderRecoveryBindingFailure');
    const message = this.deps.providerRegistry.renderBindingFailure(failure);
    return this.completeRecoveredJob(
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

  async captureProviderRecoveryAuthority(launchRecord: JobLaunch): Promise<ProviderRecoveryAuthorityCapture> {
    requireProviderLaunchRecord(launchRecord, 'captureProviderRecoveryAuthority');
    const result = await this.readProviderSession(launchRecord);
    if (result.ok) {
      return {
        ok: true,
        authority: snapshotProviderRecoveryAuthority(launchRecord, result.session, result.bound, result.continuity),
      };
    }
    return result;
  }

  async interruptAppServerJob(authority: ProviderRecoveryAuthority, runtimeRecord: AppServerRuntime): Promise<void> {
    const { launchRecord, session, boundProvider } = authority;
    if (runtimeRecord.providerMeta.leaseState !== 'acquired') {
      backendLog.warn(
        `Cannot interrupt recovered app-server job ${launchRecord.jobId}: no acquired provider lease evidence.`,
      );
      return;
    }
    const appServer = boundProvider.appServer;
    if (appServer?.supportsInterrupt !== true) return;
    const continuity = this.sessionProviderContinuity(session);
    if (!continuity) {
      return;
    }

    const request = toProviderRequest(launchRecord, session.conversationRef);
    if (
      await appServer.interrupt(runtimeRecord.providerMeta.hostRef, continuity, {
        ...this.boundHostInput(session, request),
        jobId: launchRecord.jobId,
      })
    ) {
      return;
    }
    backendLog.warn(
      `Cannot interrupt recovered app-server job ${launchRecord.jobId}: the bound host is unavailable or exact provider turn coordinates are absent.`,
    );
  }

  async finalizeInterruptedAppServerJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: AppServerRuntime,
    options: {
      reason: InterruptedAppServerReason;
      signal: AbortSignal;
      onCommitStart(): void;
    },
  ): Promise<void> {
    const { launchRecord, boundProvider } = authority;
    const status = this.deps.progressStore.readStatus(launchRecord.jobId);
    if (!status || isTerminalPhase(status.phase)) {
      if (status && options.reason === 'handoff') {
        backendLog.warn(`skipping finalize for already-terminal job ${launchRecord.jobId} during handoff recovery`);
      }
      return;
    }

    const plan = planInterruptedAppServerRecovery(authority, runtimeRecord, options.reason, {
      recovery: boundProvider.recovery !== undefined,
      probe: boundProvider.appServer?.supportsProbe === true,
    });
    options.signal.throwIfAborted();
    const performed = await performInterruptedAppServerRecovery(plan, boundProvider, {
      time: this.deps.runtime.time,
      env: this.deps.runtime.env,
      storage: this.deps.runtime.storage,
      jobDir: (jobId) => this.deps.progressStore.jobDir(jobId),
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    options.onCommitStart();
    await finalizeInterruptedAppServerRecovery(plan, performed, status, {
      runtime: this.deps.runtime,
      sessionManager: this.deps.sessionManager,
      abortRegistry: this.deps.abortRegistry,
      launchAdmission: this.deps.launchAdmission,
      jobPools: this.deps.jobPools,
    });
  }

  async recoverQueuedJob(authority: ProviderRecoveryAuthority): Promise<string> {
    const { launchRecord, session, boundProvider } = authority;
    const pool = launchRecord.pool;
    const jobId = launchRecord.jobId;

    let queuedHandle: QueuedHandle | null = null;
    try {
      this.deps.jobPools.set(jobId, pool);
      queuedHandle = this.deps.launchRecovery.restoreQueuedLaunch(
        jobId,
        launchRecord.provider,
        launchRecord.owner,
        pool,
      );
      this.deps.abortRegistry.register(jobId, () => {
        queuedHandle?.cancel();
      });

      this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

      this.deps.launchOrchestrator.runRecoveredQueuedJob(
        boundProvider,
        launchRecord,
        queuedHandle,
        pool,
        this.queuedRecoveryChildEnv(session, jobId),
      );

      return jobId;
    } catch (error: unknown) {
      this.cleanupRecoveryRegistration(jobId, pool, queuedHandle);
      throw error;
    }
  }

  async finalizeInterruptedDurableJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: DurableCliRuntimeRecord,
    observation: Readonly<{
      exit: DurableProcessExit | null;
      terminal: JobTerminal | null;
      cancelled: boolean;
    }>,
    fence: Readonly<{ signal: AbortSignal; onCommitStart(): void }>,
  ): Promise<void> {
    const { launchRecord, boundProvider } = authority;
    const status = this.deps.progressStore.readStatus(launchRecord.jobId);
    if (status === null) {
      throw new Error(`Interrupted durable recovery lost job status for ${launchRecord.jobId}.`);
    }
    const plan = planInterruptedDurableRecovery(authority, runtimeRecord, observation, {
      recovery: boundProvider.recovery !== undefined,
    });
    fence.signal.throwIfAborted();
    const performed = await performInterruptedDurableRecovery(plan, boundProvider, {
      time: this.deps.runtime.time,
      storage: this.deps.runtime.storage,
    });
    fence.signal.throwIfAborted();
    fence.onCommitStart();
    await finalizeInterruptedDurableRecovery(plan, performed, status, {
      runtime: this.deps.runtime,
      sessionManager: this.deps.sessionManager,
      abortRegistry: this.deps.abortRegistry,
      launchAdmission: this.deps.launchAdmission,
      jobPools: this.deps.jobPools,
    });
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
    try {
      this.deps.jobPools.set(jobId, pool);
      this.deps.launchRecovery.restoreActiveLaunch(jobId, launchRecord.provider, launchRecord.owner, pool);
      this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

      const pid = runtimeRecord.pid;
      this.deps.abortRegistry.register(jobId, () => {
        this.deps.runtime.process.kill(pid, 'SIGTERM');
      });
    } catch (error: unknown) {
      this.cleanupRecoveryRegistration(jobId, pool);
      throw error;
    }

    let cleaned = false;
    return {
      adopted: true,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        this.cleanupRecoveryRegistration(jobId, pool);
      },
    };
  }

  private cleanupRecoveryRegistration(jobId: string, pool: LaunchPool, queuedHandle: QueuedHandle | null = null): void {
    if (queuedHandle !== null) {
      void queuedHandle.waitForPermit().catch(() => undefined);
      queuedHandle.cancel();
    }
    this.deps.abortRegistry.remove(jobId);
    this.deps.jobPools.delete(jobId);
    this.deps.launchAdmission.releaseLaunch(jobId, pool);
  }

  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions & { pool: LaunchPool },
  ): SessionJobClaimReleaseResult {
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
    const releaseResult = this.deps.sessionManager.releaseJob(sessionId, jobId);

    const pool = this.deps.jobPools.get(jobId) ?? options.pool;
    this.deps.abortRegistry.remove(jobId);
    this.deps.jobPools.delete(jobId);
    this.deps.launchAdmission.releaseLaunch(jobId, pool);
    return releaseResult;
  }

  private sessionProviderContinuity(
    session: Pick<ProviderRecoverySession, 'providerContinuity'>,
  ): ProviderContinuityBlob | undefined {
    return session.providerContinuity ?? undefined;
  }
}
