import type { ServerResponse } from 'node:http';
import type { JobPhase } from '../jobs/phase.js';
import type { JobTerminal } from '../jobs/records.js';
import type { RpcPorts } from './rpc/ports.js';

export interface AdminControlPort {
  getLifecycleState?(): 'starting' | 'running' | 'draining' | 'stopped';
  isLifecycleRunning(): boolean;
  isDrainRequested(): boolean;
  isLaunchFenceActive(): boolean;
  beginRequest(): void;
  endRequest(): void;
  requestDrain(reason: string): void;
}

export type HealthSnapshot = {
  /**
   * Lifecycle visibility surface. `'starting'` while the daemon is binding /
   * recovering, `'ok'` once running, `'draining'` after `requestDrain` fires.
   * Handoff contenders read this to distinguish a same-bundle redundant
   * peer from a mismatch they should replace.
   */
  status: string;
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
  env: Record<string, string>;
  subsystems: {
    kb: {
      kind: 'ok' | 'unavailable';
      reason?: string;
      mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
      consumerStuck?: Array<{ id: string; elapsedSinceStopMs: number }>;
    };
    kbCurate: 'ok' | 'degraded';
    kbCurateReason?: string;
    discuss: 'ok';
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
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly admin: AdminControlPort;
  readonly health: HealthSnapshotPort;
  readonly events: EventStreamPort;
}
