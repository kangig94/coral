import type { ServerResponse } from 'node:http';
import type { TimePort } from '../infra/port-types.js';
import type { JobPhase } from '../jobs/phase.js';
import type { JobTerminal } from '../jobs/records.js';
import type { RpcPorts } from './rpc/ports.js';

export interface AdminControlPort {
  getLifecycleState?(): 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';
  isLifecycleRunning(): boolean;
  isDrainRequested(): boolean;
  isLaunchFenceActive(): boolean;
  beginRequest(): void;
  endRequest(): void;
  requestDrain(reason: string): void;
}

/**
 * Per-subsystem status entry surfaced on `/health.subsystems[]`. Structurally
 * mirrors `SubsystemStatus` from `src/coordinator/subsystems/contract.ts`
 * (the canonical authority); transport keeps a structural copy because the
 * architecture-layering invariant forbids transport from importing
 * coordinator internals. `id` is a plain string here — branding is enforced
 * producer-side; transport only emits/parses the wire value.
 */
export type TransportSubsystemStatus =
  | { id: string; phase: 'initializing'; attempt: number }
  | { id: string; phase: 'online' }
  | {
      id: string;
      phase: 'degraded';
      reason: { kind: 'curate-publish'; consecutiveFailures: number; lastError: string };
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

export type HealthSnapshot = {
  /**
   * Legacy lifecycle visibility surface kept for older CLIs that validate the
   * strict `'starting' | 'ok' | 'draining'` enum. New consumers read
   * `kernel.phase` instead. Handoff contenders read this to distinguish a
   * same-bundle redundant peer from a mismatch they should replace.
   */
  status: 'starting' | 'ok' | 'draining';
  /**
   * Authoritative kernel lifecycle. `phase` reports the full 5-state
   * `LifecycleState`; `readyAt` is the wall-clock ms when the kernel started
   * (set on the first non-`'starting'` transition) or `null` while still
   * starting.
   */
  kernel: {
    phase: 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';
    readyAt: number | null;
  };
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  /**
   * Serving process pid. Required for handoff to revalidate the signal
   * target via `probeProcessStartedAtSeconds(pid)` before SIGTERM/SIGKILL.
   */
  pid: number;
  /**
   * Serving process start time in seconds since epoch (kernel-supplied via
   * `probeProcessStartedAtSeconds`). Forms an immutable identity tuple with
   * `pid`; a mismatch means the pid has wrapped to an unrelated process.
   */
  processStartedAt?: number;
  uptimeMs: number;
  active: number;
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
  subsystems: TransportSubsystemStatus[];
  /**
   * Health diagnostics. Omitted entirely when nothing is wrong so the green
   * path stays compact and operators can grep for these keys to find
   * blocked writers / stuck consumers.
   */
  diagnostics?: {
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
  };
};

export interface HealthSnapshotPort {
  read(): HealthSnapshot;
}

export interface EventStreamHandlers {
  onJobCreated: (payload: { jobId: string; sessionId: string; provider: string; projectRoot: string }) => void;
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

export interface EventStreamPort {
  readonly bus: EventStreamBus;
  addResponse(res: ServerResponse): void;
  removeResponse(res: ServerResponse): void;
  createStreamId(): string;
  nowIsoString(): string;
  subscribe(handlers: EventStreamHandlers): void;
  unsubscribe(handlers: EventStreamHandlers): void;
}

export type HandlerIdentity = {
  pluginRoot: string;
  token: string;
  shutdownToken: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  now: () => number;
  log: (message: string) => void;
};

export interface HttpHandlerPorts extends RpcPorts {
  readonly identity: HandlerIdentity;
  readonly time?: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly admin: AdminControlPort;
  readonly health: HealthSnapshotPort;
  readonly events: EventStreamPort;
}
