import type {
  ProviderContinuityBlob,
  ProviderServerLease,
  ProviderServerSpec,
} from '../../../providers/contract.js';
import type { SessionContinuityMutation } from '../../../sessions/continuity-mutation.js';
import { backendLog } from '../../../infra/backend-log.js';
import type { SessionInterruptedFault } from '../../../sessions/fault.js';
import {
  isAppServerRuntime,
  type AppServerRuntime,
  type JobLaunch,
  type JobRuntime,
  type JobTerminalInput,
} from '../../../jobs/records.js';
import { isTerminalPhase, type JobPhase } from '../../../jobs/phase.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { SessionEntry } from '../../../sessions/entry.js';
import { nowIsoString } from '../../../infra/time.js';
import type { ProviderCatalog } from '../../../providers/catalog.js';
import type {
  ExecutionProviderServerAttachment,
  ExecutionProviderHostManager,
} from '../../contracts.js';
import type { JobAdmissionPort, JobLaunchRecoveryPort, LaunchPool } from '../../../jobs/contracts/admission.js';
import type { JobProgressStore, TerminalWriteOptions } from '../../../jobs/contracts/progress-store.js';
import type { SessionRecoveryPort } from '../../../sessions/contracts.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { RecoveredJobLifecyclePort } from '../../../jobs/contracts/job-runner.js';
import { toProviderRequest } from '../../../jobs/provider-request.js';
import {
  APP_SERVER_RECOVERY_POLICY,
  FINALIZE_CONTINUITY_MAX_RETRIES,
  buildInterruptedAppServerReport,
  isProviderContinuityBlob,
  materializeInterruptedSessionOutcome,
  type InterruptedAppServerReason,
  type InterruptedProbeOutcome,
} from '../execution-policies.js';

type ProviderLaunchRecord = JobLaunch & {
  sessionId: string;
  provider: string;
  jobKind: Exclude<JobLaunch['jobKind'], 'kb'>;
};

function requireProviderLaunchRecord(launchRecord: JobLaunch, operation: string): asserts launchRecord is ProviderLaunchRecord {
  if (launchRecord.jobKind === 'kb' || launchRecord.sessionId === null || launchRecord.provider === null) {
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
  providerHostManager: ExecutionProviderHostManager;
  launchAdmission: Pick<JobAdmissionPort, 'releaseLaunch'>;
  launchRecovery: JobLaunchRecoveryPort;
  providerRegistry: ProviderCatalog;
  jobPools: Map<string, LaunchPool>;
  launchOrchestrator: RecoveredJobLifecyclePort;
  acquireServer?: (
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ) => Promise<ProviderServerLease>;
}

export class RecoveryService {
  constructor(private readonly deps: RecoveryServiceDeps) {}

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
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, { leaseState: 'waiting' });
    }

    const lease = await this.deps.providerHostManager.acquireServer(spec, { signal: options?.signal });
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, {
        leaseState: 'acquired',
        serverGeneration: lease.generation,
      });
    }
    return lease;
  }

  async interruptAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
  ): Promise<void> {
    requireProviderLaunchRecord(launchRecord, 'interruptAppServerJob');
    const providerEntry = this.deps.providerRegistry.get(launchRecord.provider);
    const appServer = providerEntry?.appServer;
    if (!appServer) {
      return;
    }
    const session = this.deps.sessionManager.get(launchRecord.provider, launchRecord.sessionId);
    const continuity = this.resolveAppServerContinuity(runtimeRecord, session);
    if (!continuity) {
      return;
    }

    const spec = appServer.buildServerSpec(toProviderRequest(launchRecord), continuity);
    if (spec.shared !== true) {
      const liveServer = await this.deps.providerHostManager.borrowLiveServer(spec, {
        serverGeneration: runtimeRecord.providerMeta.serverGeneration,
      });
      if (liveServer) {
        await appServer.interrupt(this.createAttachedProviderServerLease(liveServer), continuity);
        return;
      }
    }

    const lease = await this.requestServer(spec);
    try {
      await appServer.interrupt(lease, continuity);
    } finally {
      lease.release();
    }
  }

  async finalizeInterruptedAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
    options: { reason: InterruptedAppServerReason },
  ): Promise<void> {
    requireProviderLaunchRecord(launchRecord, 'finalizeInterruptedAppServerJob');
    const status = this.deps.progressStore.readStatus(launchRecord.jobId);
    if (!status || isTerminalPhase(status.phase)) {
      return;
    }

    const providerEntry = this.deps.providerRegistry.get(launchRecord.provider);
    const appServer = providerEntry?.appServer;
    const recovery = providerEntry?.recovery;
    const session =
      this.deps.sessionManager.get(launchRecord.provider, launchRecord.sessionId) ??
      ({
        conversationRef: launchRecord.request.conversationRef,
      } as Pick<SessionEntry, 'conversationRef' | 'providerContinuity'>);
    const preservedConversationRef = session.conversationRef ?? launchRecord.request.conversationRef;
    const continuity = this.resolveAppServerContinuity(runtimeRecord, session);

    let mutation: SessionContinuityMutation;
    let probeOutcome: InterruptedProbeOutcome;

    if (appServer && recovery && continuity) {
      if (runtimeRecord.providerMeta.leaseState === 'waiting') {
        probeOutcome = 'waiting';
        mutation =
          recovery.finalizeInterrupted?.(
            {
              resumable: Boolean(preservedConversationRef ?? continuity),
              updatedContinuity: continuity,
            },
            continuity,
            { preservedConversationRef },
          ) ??
          (preservedConversationRef
            ? { type: 'set_resumable', conversationRef: preservedConversationRef }
            : { type: 'preserve' });
      } else {
        const spec = appServer.buildServerSpec(toProviderRequest(launchRecord), continuity);

        try {
          const liveServer =
            spec.shared !== true && runtimeRecord.providerMeta.leaseState === 'acquired'
              ? await this.deps.providerHostManager.borrowLiveServer(spec, {
                  serverGeneration: runtimeRecord.providerMeta.serverGeneration,
                })
              : null;
          const lease = liveServer
            ? this.createAttachedProviderServerLease(liveServer)
            : await this.requestServer(spec);
          try {
            const probeResult = recovery.probe
              ? await recovery.probe(lease, continuity)
              : { resumable: Boolean(preservedConversationRef ?? continuity), updatedContinuity: continuity };
            probeOutcome = probeResult.resumable ? 'verified' : 'missing';
            mutation =
              recovery.finalizeInterrupted?.(probeResult, continuity, { preservedConversationRef }) ??
              (preservedConversationRef
                ? { type: 'set_resumable', conversationRef: preservedConversationRef }
                : { type: 'preserve' });
          } finally {
            if (!liveServer) {
              lease.release();
            }
          }
        } catch (error: unknown) {
          backendLog.error(
            `Probe failed for ${launchRecord.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          probeOutcome = 'unavailable';
          mutation =
            recovery.finalizeInterrupted?.(
              {
                resumable: false,
                updatedContinuity: continuity,
              },
              continuity,
              { preservedConversationRef },
            ) ??
            (preservedConversationRef
              ? { type: 'set_resumable', conversationRef: preservedConversationRef }
              : { type: 'preserve' });
        }
      }
    } else if (preservedConversationRef) {
      probeOutcome = 'waiting';
      mutation = {
        type: 'set_resumable',
        conversationRef: preservedConversationRef,
      };
    } else {
      probeOutcome = 'waiting';
      mutation = { type: 'clear_non_resumable' };
    }

    const fault: SessionInterruptedFault = {
      trigger: options.reason,
      continuity:
        probeOutcome === 'verified'
          ? 'verified'
          : probeOutcome === 'missing'
            ? 'missing'
            : probeOutcome === 'unavailable'
              ? 'unavailable'
              : mutation.type === 'clear_non_resumable'
                ? 'pre_checkpoint_empty'
                : 'pre_checkpoint_preserved',
    };

    let reportConversationRef: string | undefined;
    if (probeOutcome === 'verified') {
      reportConversationRef = mutation.type === 'set_resumable' ? mutation.conversationRef : preservedConversationRef;
    }

    const interruptedReport = buildInterruptedAppServerReport(fault, reportConversationRef);
    const outcome = materializeInterruptedSessionOutcome(
      this.deps.progressStore,
      launchRecord.jobId,
      launchRecord.sessionId,
      fault,
    );

    this.deps.launchOrchestrator.writeJobTerminal(
      launchRecord.jobId,
      launchRecord.sessionId,
      { content: interruptedReport, outcome },
      'error',
    );
    try {
      writeResultArtifact(this.deps.runtime.storage, launchRecord.jobId, interruptedReport);
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

  recoverQueuedJob(launchRecord: JobLaunch): string {
    requireProviderLaunchRecord(launchRecord, 'recoverQueuedJob');
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;

    this.deps.jobPools.set(jobId, pool);

    const queuedHandle = this.deps.launchRecovery.restoreQueuedLaunch(jobId, launchRecord.provider, pool);
    this.deps.abortRegistry.register(jobId, () => {
      queuedHandle.cancel();
    });

    this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

    const provider = this.deps.providerRegistry.get(launchRecord.provider);
    if (provider) {
      this.deps.launchOrchestrator.runRecoveredQueuedJob(provider, launchRecord, queuedHandle, pool);
    }

    return jobId;
  }

  adoptRunningJob(launchRecord: JobLaunch, runtimeRecord: JobRuntime): { cleanup: () => void } {
    requireProviderLaunchRecord(launchRecord, 'adoptRunningJob');
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;

    if (!isDurableCliRuntime(runtimeRecord)) {
      throw new Error(`Unsupported runtime transport for adoptRunningJob(${jobId}): ${runtimeRecord.transport}`);
    }

    this.deps.jobPools.set(jobId, pool);
    this.deps.progressStore.hydrateJobStartedAt(jobId, runtimeRecord.startTime);

    this.deps.launchRecovery.restoreActiveLaunch(jobId, launchRecord.provider, pool);
    this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

    const pid = runtimeRecord.pid;
    this.deps.abortRegistry.register(jobId, () => {
      this.deps.runtime.process.kill(pid, 'SIGTERM');
    });

    let cleaned = false;
    return {
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
    this.deps.launchOrchestrator.writeJobTerminal(jobId, sessionId, result, phase, {
      ...options,
      continuity: options?.continuity ?? null,
    });
    try {
      writeResultArtifact(this.deps.runtime.storage, jobId, result.content);
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifact failed for ${jobId}: ${String(error)}`);
    }
    this.deps.abortRegistry.remove(jobId);
    const pool = this.deps.jobPools.get(jobId) ?? 'default';
    this.deps.launchAdmission.releaseLaunch(jobId, pool);
    this.deps.jobPools.delete(jobId);

    const continuity = options?.continuity ?? null;
    if (continuity?.providerContinuity) {
      this.deps.sessionManager.checkpointProviderContinuity(sessionId, {
        providerContinuity: continuity.providerContinuity,
        ...(continuity.conversationRef === null ? {} : { conversationRef: continuity.conversationRef }),
      });
    } else if (continuity?.conversationRef) {
      this.deps.sessionManager.setConversationRef(sessionId, continuity.conversationRef);
    }
    if (continuity && !continuity.resumable) {
      this.deps.sessionManager.setNonResumable(sessionId);
    }
    this.deps.sessionManager.releaseJob(sessionId, jobId);
  }

  private createAttachedProviderServerLease(
    attachment: ExecutionProviderServerAttachment,
  ): ProviderServerLease {
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
        recoveryPolicy: APP_SERVER_RECOVERY_POLICY,
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
