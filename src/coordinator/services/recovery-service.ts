import type {
  ProviderContinuityBlob,
  ProviderRecoveryMeta,
  ProviderServerLease,
  ProviderServerSpec,
} from '../../providers/provider-contracts.js';
import { backendLog } from '../../shared/backend-log.js';
import {
  isAppServerRuntime,
  isTerminalPhase,
  type AppServerRuntime,
  type JobLaunch,
  type JobPhase,
  type JobRuntime,
  type JobTerminal,
  writeWorkflowResult,
} from '../../jobs/api.js';
import type { ProviderRequest, ProviderTerminalEventBody } from '../../providers/protocol.js';
import { isDurableCliRuntime } from '../../runtime/durable-runtime.js';
import type { SessionEntry } from '../../sessions/api.js';
import { nowIsoString } from '../../shared/utils.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import {
  getProviderAppServer,
  getProviderRecovery,
  migrateLegacyContinuity,
  toLegacyProviderExecutor,
} from '../../providers/spec-compat.js';
import type {
  ExecutionLaunchCoordinator,
  ExecutionLaunchPool as LaunchPool,
  ExecutionProviderServerAttachment,
  ExecutionProviderHostManager,
} from '../contracts.js';
import type { ProgressStore } from '../../jobs/job-store.js';
import type { SessionManager } from '../../sessions/shell/store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { AbortRegistry } from '../../jobs/shell/abort-registry.js';
import type { LaunchOrchestrator } from '../../jobs/shell/launch.js';
import { toProviderRequest } from '../../jobs/shell/contracts.js';
import {
  APP_SERVER_RECOVERY_POLICY,
  FINALIZE_CONTINUITY_MAX_RETRIES,
  buildInterruptedAppServerReport,
  isProviderContinuityBlob,
  normalizeLegacyFaultOutcome,
  type InterruptedAppServerFinalization,
  type InterruptedAppServerReason,
  type InterruptedProbeOutcome,
} from './execution-shared.js';
import {
  describeLegacyCoralFault,
  type RecoveryFaultCompat,
} from '../../shared/legacy-terminal-outcome-compat.js';

export interface RecoveryServiceDeps {
  runtime: Runtime;
  sessionManager: SessionManager;
  abortRegistry: AbortRegistry;
  backendNamespace: string;
  bundleHash: string;
  progressStore: ProgressStore;
  providerHostManager: ExecutionProviderHostManager;
  launchCoordinator: ExecutionLaunchCoordinator;
  providerRegistry: ProviderRegistry;
  jobPools: Map<string, LaunchPool>;
  launchOrchestrator: LaunchOrchestrator;
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

  checkpointRecovery(jobId: string, update: { conversationRef?: string; providerMeta: ProviderRecoveryMeta }): void {
    const runtimeRecord = this.deps.progressStore.readRuntimeRecord(jobId);
    if (!isAppServerRuntime(runtimeRecord)) {
      throw new Error(`checkpointRecovery(${jobId}) requires an app-server runtime record`);
    }
    const providerMetaUpdate = update.providerMeta as Partial<AppServerRuntime['providerMeta']>;

    const nextRecord: AppServerRuntime = {
      ...runtimeRecord,
      providerMeta: {
        ...runtimeRecord.providerMeta,
        ...providerMetaUpdate,
        recoveryPolicy: APP_SERVER_RECOVERY_POLICY,
      },
    };
    this.deps.progressStore.writeRuntimeRecord(jobId, nextRecord);

    const status = this.deps.progressStore.readStatus(jobId);
    if (status && isProviderContinuityBlob(nextRecord.providerMeta.providerContinuity)) {
      this.deps.sessionManager.checkpointProviderContinuity(status.sessionId, {
        providerContinuity: nextRecord.providerMeta.providerContinuity,
        conversationRef: update.conversationRef,
      });
      return;
    }

    if (status && update.conversationRef) {
      this.deps.sessionManager.setConversationRef(status.sessionId, update.conversationRef);
    }
  }

  async interruptAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
  ): Promise<void> {
    const providerEntry = this.deps.providerRegistry.get(launchRecord.provider);
    const appServer = getProviderAppServer(providerEntry);
    if (!appServer) {
      return;
    }
    const session = this.deps.sessionManager.get(launchRecord.provider, launchRecord.sessionId);
    const continuity = this.resolveAppServerContinuity(launchRecord.provider, runtimeRecord, session);
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
    const status = this.deps.progressStore.readStatus(launchRecord.jobId);
    if (!status || isTerminalPhase(status.phase)) {
      return;
    }

    const providerEntry = this.deps.providerRegistry.get(launchRecord.provider);
    const appServer = getProviderAppServer(providerEntry);
    const recovery = getProviderRecovery(providerEntry);
    const session =
      this.deps.sessionManager.get(launchRecord.provider, launchRecord.sessionId) ??
      ({
        conversationRef: launchRecord.request.conversationRef,
      } as Pick<SessionEntry, 'conversationRef' | 'providerContinuity'>);
    const preservedConversationRef = session.conversationRef ?? launchRecord.request.conversationRef;
    const continuity = this.resolveAppServerContinuity(launchRecord.provider, runtimeRecord, session);

    const toMutation = (finalization: InterruptedAppServerFinalization) => {
      if (finalization.nonResumable) {
        return {
          type: 'clear_non_resumable',
          ...(finalization.continuityMutation ? { providerContinuity: finalization.continuityMutation } : {}),
        } as const;
      }

      const conversationRef = finalization.conversationRef ?? preservedConversationRef;
      if (conversationRef) {
        return {
          type: 'set_resumable',
          conversationRef,
          ...(finalization.continuityMutation ? { providerContinuity: finalization.continuityMutation } : {}),
        } as const;
      }

      return {
        type: 'preserve',
        ...(finalization.continuityMutation ? { providerContinuity: finalization.continuityMutation } : {}),
      } as const;
    };

    let mutation:
      | { type: 'set_resumable'; conversationRef: string; providerContinuity?: ProviderContinuityBlob }
      | { type: 'clear_non_resumable'; providerContinuity?: ProviderContinuityBlob }
      | { type: 'preserve'; providerContinuity?: ProviderContinuityBlob };
    let probeOutcome: InterruptedProbeOutcome;

    if (appServer && recovery && continuity) {
      if (runtimeRecord.providerMeta.leaseState === 'waiting') {
        probeOutcome = 'waiting';
        mutation = toMutation(
          recovery.finalizeInterrupted?.(
            {
              resumable: Boolean(preservedConversationRef ?? continuity),
              updatedContinuity: continuity,
            },
            continuity,
          ) ?? {},
        );
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
            mutation = toMutation(recovery.finalizeInterrupted?.(probeResult, continuity) ?? {});
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
          mutation = toMutation(
            recovery.finalizeInterrupted?.(
              {
                resumable: false,
                updatedContinuity: continuity,
              },
              continuity,
            ) ?? {},
          );
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

    const fault: Extract<RecoveryFaultCompat, { kind: 'app_server_interrupted' }> = {
      kind: 'app_server_interrupted',
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
    const outcome = normalizeLegacyFaultOutcome(
      this.deps.progressStore,
      launchRecord.jobId,
      launchRecord.sessionId,
      fault,
    );

    this.deps.progressStore.updateLaunchState(launchRecord.jobId, 'error', describeLegacyCoralFault(fault));
    this.deps.launchOrchestrator.writeJobTerminal(
      launchRecord.jobId,
      launchRecord.sessionId,
      {
        content: interruptedReport,
        outcome,
        ...(probeOutcome === 'missing' || probeOutcome === 'unavailable' ? { nonResumable: true } : {}),
      },
      'error',
    );
    this.deps.progressStore.writeResultMd(launchRecord.jobId, interruptedReport);
    writeWorkflowResult(this.deps.runtime.storage, launchRecord.jobId, interruptedReport);
    this.deps.abortRegistry.remove(launchRecord.jobId);
    this.deps.launchCoordinator.releaseLaunch(
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
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;

    this.deps.jobPools.set(jobId, pool);
    this.deps.progressStore.hydrateEventCounter(jobId);

    const queuedHandle = this.deps.launchCoordinator.restoreQueuedLaunch(jobId, launchRecord.provider, pool);
    this.deps.abortRegistry.register(jobId, () => {
      queuedHandle.cancel();
    });

    this.deps.progressStore.rebindNamespace(jobId, this.deps.backendNamespace, this.deps.bundleHash);

    const provider = toLegacyProviderExecutor(this.deps.providerRegistry.get(launchRecord.provider));
    if (provider) {
      this.deps.launchOrchestrator.runRecoveredQueuedJob(provider, launchRecord, queuedHandle, pool);
    }

    return jobId;
  }

  adoptRunningJob(launchRecord: JobLaunch, runtimeRecord: JobRuntime): { cleanup: () => void } {
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;

    if (!isDurableCliRuntime(runtimeRecord)) {
      throw new Error(`Unsupported runtime transport for adoptRunningJob(${jobId}): ${runtimeRecord.transport}`);
    }

    this.deps.jobPools.set(jobId, pool);
    this.deps.progressStore.hydrateEventCounter(jobId);
    this.deps.progressStore.hydrateJobStartedAt(jobId, runtimeRecord.startTime);

    this.deps.launchCoordinator.restoreActiveLaunch(jobId, launchRecord.provider, pool);
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
        this.deps.launchCoordinator.releaseLaunch(jobId, pool);
        this.deps.jobPools.delete(jobId);
      },
    };
  }

  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminal,
    phase: JobPhase,
    options?: {
      continuity?: {
        conversationRef: string | null;
        resumable: boolean;
        providerContinuity?: ProviderContinuityBlob;
      };
    },
  ): void {
    this.deps.launchOrchestrator.writeJobTerminal(jobId, sessionId, result, phase);
    this.deps.progressStore.writeResultMd(jobId, result.content);
    writeWorkflowResult(this.deps.runtime.storage, jobId, result.content);
    this.deps.abortRegistry.remove(jobId);
    const pool = this.deps.jobPools.get(jobId) ?? 'default';
    this.deps.launchCoordinator.releaseLaunch(jobId, pool);
    this.deps.jobPools.delete(jobId);

    const continuity = options?.continuity;
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

  async finalizeProviderSession(
    providerName: string,
    request: ProviderRequest,
    sessionId: string,
    jobId: string,
    result: ProviderTerminalEventBody,
  ): Promise<void> {
    const providerEntry = this.deps.providerRegistry.get(providerName);
    const appServer = getProviderAppServer(providerEntry);
    const runtimeRecord = this.deps.progressStore.readRuntimeRecord(jobId);
    if (appServer && isAppServerRuntime(runtimeRecord)) {
      const continuity = this.resolveAppServerContinuity(
        providerName,
        runtimeRecord,
        this.deps.sessionManager.get(providerName, sessionId),
      );

      if (request.action === 'resume' && result.nonResumable && !continuity) {
        await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
          type: 'clear_non_resumable',
        });
        return;
      }

      if (result.conversationRef && !continuity) {
        await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
          type: 'set_resumable',
          conversationRef: result.conversationRef,
        });
        return;
      }

      await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
        type: 'preserve',
      });
      return;
    }

    if (request.action === 'resume' && result.nonResumable) {
      await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
        type: 'clear_non_resumable',
      });
      return;
    }

    if (result.conversationRef) {
      this.deps.sessionManager.setConversationRef(sessionId, result.conversationRef);
    } else if (result.nonResumable) {
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
    providerName: string,
    runtimeRecord: AppServerRuntime,
    session?: Pick<SessionEntry, 'providerContinuity'> | null,
  ): ProviderContinuityBlob | undefined {
    if (isProviderContinuityBlob(runtimeRecord.providerMeta.providerContinuity)) {
      return runtimeRecord.providerMeta.providerContinuity;
    }
    if (isProviderContinuityBlob(session?.providerContinuity)) {
      return session.providerContinuity;
    }

    return this.deps.providerRegistry
      .get(providerName)
      ? migrateLegacyContinuity(
          this.deps.providerRegistry.get(providerName),
          runtimeRecord.providerMeta as Record<string, unknown>,
        )
      : undefined;
  }

  private writeAppServerRuntimeRecord(
    jobId: string,
    providerName: string,
    update: Partial<AppServerRuntime['providerMeta']>,
  ): void {
    const current = this.deps.progressStore.readRuntimeRecord(jobId);
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
    this.deps.progressStore.writeRuntimeRecord(jobId, record);
  }

  private async finalizeSessionContinuityMutation(
    providerName: string,
    sessionId: string,
    jobId: string,
    mutation:
      | { type: 'set_resumable'; conversationRef: string; providerContinuity?: ProviderContinuityBlob }
      | { type: 'clear_non_resumable'; providerContinuity?: ProviderContinuityBlob }
      | { type: 'preserve'; providerContinuity?: ProviderContinuityBlob },
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
