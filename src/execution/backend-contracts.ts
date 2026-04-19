/**
 * Dependency injection contracts for the decomposed backend server.
 *
 * These interfaces make the closure dependencies of the former monolithic
 * `createBackendServer()` explicit so that http-handler.ts and lifecycle.ts
 * receive only what they need.
 */

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { AbortResult } from '../shared/execution-contracts.js';
import { backendLog } from '../shared/backend-log.js';
import type { JobPhase, JobTerminalRecord } from '../shared/types.js';
import type { DiscussContext } from '../discuss/shell/context.js';
import type { IdleTimer } from '../coordinator/live/idle.js';
import type { ProgressStore } from './progress-store.js';
import type { CallerContext } from '../shared/request-context.js';
import type { LifecycleState } from './server-types.js';
import type { ExecutionService } from './service.js';
import type { KnowledgeBaseRuntime } from './kb-tools.js';
import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../discuss/views.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Runtime } from '../runtime/ports.js';

export type EventBusEvents = {
  'job:created': { jobId: string; sessionId: string; provider: string; projectRoot: string };
  'job:phase_changed': { jobId: string; phase: JobPhase; previousPhase: JobPhase };
  'job:progress': { jobId: string; eventId: number; message: string };
  'job:completed': {
    jobId: string;
    result: JobTerminalRecord;
    costUsd?: number;
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
  'discuss:updated': { projectRoot: string; sessionId: string; lastSeq: number; status: string };
};

const MAX_EVENT_BUS_LISTENERS = 100;

export class TypedEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(MAX_EVENT_BUS_LISTENERS);
  }

  on<K extends keyof EventBusEvents>(event: K, listener: (payload: EventBusEvents[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends keyof EventBusEvents>(event: K, listener: (payload: EventBusEvents[K]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit<K extends keyof EventBusEvents>(event: K, payload: EventBusEvents[K]): boolean {
    const listeners = this.emitter.listeners(event) as Array<(value: EventBusEvents[K]) => unknown>;
    if (listeners.length === 0) return false;

    for (const listener of listeners) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          void result.catch((error: unknown) => {
            backendLog.error(`EventBus listener for ${String(event)} failed`, error);
          });
        }
      } catch (error: unknown) {
        backendLog.error(`EventBus listener for ${String(event)} failed`, error);
      }
    }

    return true;
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }

  reset(): this {
    return this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// BackendIdentity — immutable config/identity for a backend instance
// ---------------------------------------------------------------------------

export interface BackendIdentity {
  readonly pluginRoot: string;
  readonly namespace: string;
  readonly version: string;
  readonly bundleHash: string;
  readonly flavor: 'prod' | 'dev';
  readonly instanceId: string;
  readonly token: string;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// ---------------------------------------------------------------------------
// BackendRuntimeState — shared mutable state cell
// ---------------------------------------------------------------------------

export interface ReadonlyBackendRuntimeState {
  getLifecycle(): LifecycleState;
  getStartedAt(): number;
  getKbSubsystem(): KnowledgeBaseRuntime | null;
  getKbInitError(): string | null;
  getLaunchFenceActive(): boolean;
}

export interface MutableBackendRuntimeState extends ReadonlyBackendRuntimeState {
  setLifecycle(state: LifecycleState): void;
  setStartedAt(ts: number): void;
  setKbSubsystem(kb: KnowledgeBaseRuntime | null): void;
  setKbInitError(error: string | null): void;
  setLaunchFenceActive(active: boolean): void;
}

// ---------------------------------------------------------------------------
// HttpHandlerDeps — everything the HTTP handler needs at request-time
// ---------------------------------------------------------------------------

export type ExecutionServiceLike = Pick<
  ExecutionService,
  'start' | 'resumeBySessionId' | 'forkBySessionId' | 'executeWorkflow' | 'abort' | 'waitStream' | 'waitStreamOnce'
>;

export type ScopeCheckResult = {
  valid: string[];
  missing: string[];
  mismatch: string[];
};

export interface HttpHandlerDeps {
  // Identity / config
  readonly identity: BackendIdentity;
  readonly runtime: Pick<Runtime, 'ids' | 'time' | 'storage'>;

  // Shared runtime state (read-only from HTTP perspective)
  readonly runtimeState: ReadonlyBackendRuntimeState;

  // Runtime services
  readonly idleTimer: IdleTimer;
  readonly progressStore: ProgressStore;
  readonly activeLaunchCount: () => number;
  readonly queueDepth: () => number;
  readonly streamResponses: Set<ServerResponse>;
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly resolveProjectSource: (projectRoot: string) => string;

  // Drain admission fence — immediately true after /admin/shutdown, before lifecycle flips
  isDrainRequested(): boolean;
  requestDrain(reason: string): void;

  // Request-time control ports
  readonly getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
  readonly getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readonly providerRegistry: ProviderRegistry;
  readonly abortJobs: (jobIds: string[]) => AbortResult;
  readonly scopeCheckJobs: (jobIds: string[], projectRoot: string) => ScopeCheckResult;

  // Event-stream authority
  readonly subscribeBackendEvents: (handlers: EventStreamHandlers) => void;
  readonly unsubscribeBackendEvents: (handlers: EventStreamHandlers) => void;

  // Discuss read ports (narrowed — no registry internals)
  readonly liveDiscussCount: () => number;
  readonly listDiscussSessions: () => DiscussSummaryDto[];
  readonly loadDiscussDetail: (
    source: string,
    sessionId: string,
    view: DiscussView,
  ) => DiscussDetailResponse | 'audit_requires_ended_session' | null;
}

// ---------------------------------------------------------------------------
// EventStreamHandlers — event bus listener set for /events/stream
// ---------------------------------------------------------------------------

export interface EventStreamHandlers {
  onJobCreated: (payload: EventBusEvents['job:created']) => void;
  onPhaseChanged: (payload: EventBusEvents['job:phase_changed']) => void;
  onProgress: (payload: EventBusEvents['job:progress']) => void;
  onCompleted: (payload: EventBusEvents['job:completed']) => void;
  onDiscussUpdated: (payload: EventBusEvents['discuss:updated']) => void;
}
