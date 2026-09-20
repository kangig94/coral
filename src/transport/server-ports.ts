import type { ProcessIncarnation } from '../infra/node-process.js';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import type { TimePort } from '../infra/port-types.js';
import type { ShutdownRemainderCleanupRefusal } from '../infra/shutdown-remainder-record.js';
import type { JobPhase } from '../jobs/phase.js';
import type { JobTerminal } from '../jobs/records.js';
import type { JobCreatedEvent } from '../jobs/contracts/event-stream.js';
import { executionOwnerSchema } from '../runtime/execution-owner.js';
import type { RpcPorts } from './rpc/ports.js';
import type { Principal } from '../security/principal.js';
import type { IpcAuthMetadata } from './ipc/json-rpc.js';
import type { ProviderScope } from '../infra/provider-scope.js';
import type {
  ProviderProxySetDurableDispositionSkipStatus,
  ProviderProxySetOperatorStatus,
} from '../provider-proxy/operator-disposition-vocabulary.js';

interface AdminControlPort {
  getLifecycleState?(): 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';
  isLifecycleRunning(): boolean;
  isDrainRequested(): boolean;
  isLaunchFenceActive(): boolean;
  beginRequest(): void;
  endRequest(): void;
  requestDrain(reason: 'replaced'): void;
  probeKbDaemon?(): Promise<TransportKbDaemonHealthSnapshot>;
  restartKbDaemon?(reason: string): Promise<TransportKbDaemonHealthSnapshot>;
}

/**
 * Per-component status entry surfaced on `/health.components[]`. Structurally
 * mirrors `RuntimeComponentStatus` from `src/coordinator/runtime-components/contract.ts`
 * (the canonical authority); transport keeps a structural copy because the
 * architecture-layering invariant forbids transport from importing
 * coordinator internals. `id` is a plain string here — branding is enforced
 * producer-side; transport only emits/parses the wire value.
 */
export type TransportRuntimeComponentStatus =
  | { id: string; phase: 'initializing'; attempt: number }
  | { id: string; phase: 'online' }
  | {
      id: string;
      phase: 'degraded';
      reason:
        | { kind: 'curate-publish'; consecutiveFailures: number; lastError: string }
        | { kind: 'recovery-quarantine'; count: number; lastError: string };
    }
  | {
      id: string;
      phase: 'offline';
      reason: string;
      lastLogLine?: string;
      diagnostic?: {
        attempts?: number;
        failedStep?: string;
        retry?: 'restart-daemon' | 'none';
        lastErrorStack?: string;
      };
    };

export type TextProjectionHealthState = 'idle' | 'fetching' | 'reindexing';

type TransportKbDaemonPhase = 'disabled' | 'starting' | 'online' | 'restarting' | 'stopping' | 'stopped' | 'failed';

type TransportKbDaemonRuntimeHealthPhase = 'not_initialized' | 'ready' | 'failed' | 'disposing' | 'disposed';

type TransportKbDaemonRuntimeHealth = {
  phase: TransportKbDaemonRuntimeHealthPhase;
  initializedAt?: number;
  lastError?: string;
  curateRunning?: boolean;
  mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
};

type TransportKbDaemonHealthSnapshot = {
  enabled: boolean;
  phase: TransportKbDaemonPhase;
  generation: number;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  entrypoint?: string;
  pendingRequests?: number;
  lastHeartbeatAt?: number;
  lastHeartbeatLatencyMs?: number;
  daemonUptimeMs?: number;
  kbRead?: TransportKbDaemonRuntimeHealth;
  kbWrite?: TransportKbDaemonRuntimeHealth;
  reason?: string;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: number;
    uptimeMs: number | null;
  };
  lastError?: string;
};

const launchPermitHolderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-execution') }).strict(),
  z.object({ kind: z.literal('system-task'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('proxy-operation'), operationId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('recovery') }).strict(),
  z
    .object({
      kind: z.literal('undecided-provider-operation'),
      recordKeys: z.array(z.string().min(1)).min(1).readonly(),
    })
    .strict(),
  z.object({ kind: z.literal('queue-handoff') }).strict(),
]);

const launchPoolSchema = z.enum(['default', 'discuss', 'curate']);
const launchJobReclamationEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('job-absent') }).strict(),
  z.object({ kind: z.literal('job-terminal'), phase: z.enum(['completed', 'error', 'aborted']) }).strict(),
]);
const launchReclamationBaseShape = {
  reservationId: z.string().min(1),
  jobId: z.string().min(1),
  pool: launchPoolSchema,
  provider: z.string().min(1),
  heldForMs: z.number().finite().nonnegative(),
  reclaimedAtMs: z.number().finite().nonnegative(),
};
const launchReclamationDiagnosticSchema = z.union([
  z
    .object({
      ...launchReclamationBaseShape,
      holder: z.object({ kind: z.literal('local-execution') }).strict(),
      evidence: launchJobReclamationEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...launchReclamationBaseShape,
      holder: z.object({ kind: z.literal('recovery') }).strict(),
      evidence: launchJobReclamationEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...launchReclamationBaseShape,
      holder: z.object({ kind: z.literal('proxy-operation'), operationId: z.string().min(1) }).strict(),
      evidence: z
        .object({
          kind: z.literal('provider-operation-absent'),
          operationId: z.string().min(1),
          jobEvidence: launchJobReclamationEvidenceSchema,
        })
        .strict(),
    })
    .strict()
    .refine((diagnostic) => diagnostic.holder.operationId === diagnostic.evidence.operationId),
  z
    .object({
      ...launchReclamationBaseShape,
      holder: z
        .object({
          kind: z.literal('undecided-provider-operation'),
          recordKeys: z.array(z.string().min(1)).min(1).readonly(),
        })
        .strict(),
      evidence: z
        .object({
          kind: z.literal('provider-operation-records-absent'),
          recordKeys: z.array(z.string().min(1)).min(1).readonly(),
          jobEvidence: launchJobReclamationEvidenceSchema,
        })
        .strict(),
    })
    .strict()
    .refine(
      (diagnostic) =>
        new Set(diagnostic.holder.recordKeys).size === new Set(diagnostic.evidence.recordKeys).size &&
        diagnostic.holder.recordKeys.every((key) => diagnostic.evidence.recordKeys.includes(key)),
    ),
]);

export const launchPermitDiagnosticsSchema = z
  .object({
    launchPermits: z
      .array(
        z
          .object({
            reservationId: z.string().min(1),
            jobId: z.string().min(1),
            pool: launchPoolSchema,
            provider: z.string().min(1),
            holder: launchPermitHolderSchema,
            executionOwner: executionOwnerSchema,
            heldForMs: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    settlementRefusalRecordingFailures: z
      .array(
        z.union([
          z
            .object({
              jobId: z.string().min(1),
              cause: z.enum(['terminal-persist-failed', 'claim-release-failed', 'claim-already-reassigned']),
              error: z.string().min(1),
              observedAtMs: z.number().finite().nonnegative(),
            })
            .strict(),
          z
            .object({
              jobId: z.string().min(1),
              operationId: z.string().min(1),
              cause: z.literal('settled-unbound-status-persist-failed'),
              error: z.string().min(1),
              observedAtMs: z.number().finite().nonnegative(),
            })
            .strict(),
        ]),
      )
      .optional(),
    launchReleaseDispositions: z
      .array(
        z
          .object({
            reservationId: z.string().min(1),
            jobId: z.string().min(1),
            pool: launchPoolSchema,
            provider: z.string().min(1),
            attemptedHolder: launchPermitHolderSchema,
            disposition: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('already-released'), pool: launchPoolSchema }).strict(),
              z
                .object({ kind: z.literal('transferred'), pool: launchPoolSchema, holder: launchPermitHolderSchema })
                .strict(),
            ]),
            observedAtMs: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    providerOperationAdoptionRefusals: z
      .array(
        z
          .object({
            triggerRecordKey: z.string().min(1),
            rowDisposition: z.enum(['discarded', 'absent']),
            releasedLaunchPermits: z.number().int().nonnegative(),
            recordKey: z.string().min(1),
            jobId: z.string().min(1),
            operationId: z.string().min(1),
            proxyInstanceId: z.string().min(1),
            buildSetId: z.string().min(1),
            reason: z.string().min(1),
            remedy: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('restart-coordinator') }).strict(),
              z.object({ kind: z.literal('remote-settlement') }).strict(),
              z
                .object({
                  kind: z.literal('recovery-quarantine-discard'),
                  command: z.union([
                    z.object({ kind: z.literal('list') }).strict(),
                    z
                      .object({
                        kind: z.literal('discard-provider-operation'),
                        key: z.string().min(1),
                        revision: z.string().min(1),
                        allowReadable: z.boolean(),
                      })
                      .strict(),
                  ]),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('recovery-quarantine-clear'),
                  command: z.union([
                    z.object({ kind: z.literal('list') }).strict(),
                    z
                      .object({
                        kind: z.literal('clear'),
                        boundary: z.string().min(1),
                        key: z.string().min(1),
                        revision: z.string().min(1),
                      })
                      .strict(),
                  ]),
                })
                .strict(),
              z.object({ kind: z.literal('external-repair') }).strict(),
            ]),
            observedAtMs: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    launchReclamations: z.array(launchReclamationDiagnosticSchema).optional(),
  })
  .strict();

export type LaunchPermitDiagnostics = z.infer<typeof launchPermitDiagnosticsSchema>;

export type HealthSnapshot = {
  /**
   * Coarse lifecycle visibility surface for clients that validate the strict
   * `'starting' | 'ok' | 'draining'` enum. Consumers that need the full
   * lifecycle read `kernel.phase` instead. Handoff contenders read this to
   * distinguish exact reuse from a validated newer-target handoff without
   * replacing a healthy incumbent.
   */
  status: 'starting' | 'ok' | 'draining';
  /**
   * Authoritative kernel lifecycle. `readyAt` is the wall-clock ms when the
   * kernel started (set on the first non-`'starting'` transition) or `null`
   * while still starting.
   */
  kernel: {
    phase: 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';
    readyAt: number | null;
  };
  version: string;
  bundleHash: string;
  /**
   * Authenticated foreign-build identity. Strict production builds publish
   * both fields together; older and non-strict development builds omit both.
   */
  manifest?: StrictBundleManifest;
  bundleDir?: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  /**
   * Serving process pid. Required for handoff to revalidate the signal
   * target via `probeProcessIncarnation(pid)` before SIGTERM/SIGKILL.
   */
  pid: number;
  /**
   * Serving process incarnation: an opaque token compared only for equality
   * (`probeProcessIncarnation`). Forms an immutable identity tuple with
   * `pid`; a mismatch means the pid has wrapped to an unrelated process.
   */
  incarnation?: ProcessIncarnation;
  uptimeMs: number;
  active: number;
  /** Jobs whose local carrier is live or unresolved; build namespace is provenance, not ownership scope. */
  activeJobs: number;
  liveDiscuss: number;
  queueDepth: number;
  inflightRequests: number;
  textProjectionState: TextProjectionHealthState;
  resources?: {
    rssBytes: number;
    heapUsedBytes: number;
    eventLoopLagMs: number;
    ipcOpenSockets: number;
    eventStreamResponses: number;
    fdCount?: number;
  };
  env: Record<string, string>;
  systemProviderScope?: { name: string; providers: string[] };
  components: TransportRuntimeComponentStatus[];
  kbDaemon?: TransportKbDaemonHealthSnapshot;
  shutdownRemainderCleanupRefusals?: readonly ShutdownRemainderCleanupRefusal[];
  resolvedShutdownRemainderCleanupRefusalCount?: number;
  absentShutdownRemainderCleanupRefusalCount?: number;
  unobservableShutdownRemainderCleanupRefusalCount?: number;
  uncheckedShutdownRemainderCleanupRefusalCount?: number;
  /**
   * Carrier coverage is observational even when complete. Incident-only fields remain omitted when healthy
   * so operators can still grep for blocked writers and stuck consumers.
   */
  diagnostics?: LaunchPermitDiagnostics & {
    carriers?: {
      coverage: 'complete' | 'unknown';
      liveJobs: number;
      unknownJobs: number;
      recoveryDefectJobs: number;
    };
    mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
    consumerStuck?: Array<{
      id: string;
      elapsedSinceStopMs: number;
      authority?: 'journal' | 'corpus';
      cursor?: number;
      snapshotId?: string | null;
      contentSeq?: number;
      metadataSeq?: number;
    }>;
    providerProxySets?: ProviderProxySetOperatorStatus[];
    providerProxyDispositionSkips?: ProviderProxySetDurableDispositionSkipStatus[];
  };
};

interface HealthSnapshotPort {
  read(): HealthSnapshot;
}

export type RemoteHttpAccessPolicy = {
  readonly mode: 'loopback' | 'address_allowlist' | 'unrestricted';
  readonly allowedRemoteAddresses?: readonly string[];
};

export interface EventStreamHandlers {
  onJobCreated: (payload: JobCreatedEvent) => void;
  onPhaseChanged: (payload: { jobId: string; phase: JobPhase; previousPhase: JobPhase }) => void;
  onProgress: (payload: { jobId: string; seq: number; message: string }) => void;
  onCompleted: (payload: {
    jobId: string;
    result: JobTerminal;
    costUsd?: number;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  }) => void;
  onDiscussUpdated: (payload: { projectRoot: string; sessionId: string; lastSeq: number; status: string }) => void;
}

export type EventStreamEventMap = {
  'job:created': Parameters<EventStreamHandlers['onJobCreated']>[0];
  'job:phase_changed': Parameters<EventStreamHandlers['onPhaseChanged']>[0];
  'job:progress': Parameters<EventStreamHandlers['onProgress']>[0];
  'job:completed': Parameters<EventStreamHandlers['onCompleted']>[0];
  'discuss:updated': Parameters<EventStreamHandlers['onDiscussUpdated']>[0];
};

export interface EventStreamBus {
  on<K extends keyof EventStreamEventMap>(event: K, listener: (payload: EventStreamEventMap[K]) => void): this;
  off<K extends keyof EventStreamEventMap>(event: K, listener: (payload: EventStreamEventMap[K]) => void): this;
}

interface EventStreamPort {
  readonly bus: EventStreamBus;
  addResponse(res: ServerResponse): void;
  removeResponse(res: ServerResponse): void;
  createStreamId(): string;
  nowIsoString(): string;
  subscribe(handlers: EventStreamHandlers): void;
  unsubscribe(handlers: EventStreamHandlers): void;
}

type HandlerIdentity = {
  pluginRoot: string;
  token: string;
  bootToken: string;
  shutdownToken: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  now: () => number;
  log: (message: string) => void;
};

interface ChildPrincipalRegistryPort {
  authenticate(auth: Extract<IpcAuthMetadata, { kind: 'child' }>, namespace: string, nowMs: number): Principal | null;
}

export interface HttpHandlerPorts extends RpcPorts {
  readonly identity: HandlerIdentity;
  readonly time?: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly systemProviderScope?: Extract<ProviderScope, { origin: 'system' }>;
  readonly remoteAccess?: RemoteHttpAccessPolicy;
  readonly admin: AdminControlPort;
  readonly health: HealthSnapshotPort;
  readonly events: EventStreamPort;
  readonly childPrincipals?: ChildPrincipalRegistryPort;
}
