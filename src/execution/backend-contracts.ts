/**
 * Dependency injection contracts for the decomposed backend server.
 *
 * These interfaces make the closure dependencies of the former monolithic
 * `createBackendServer()` explicit so that http-handler.ts and lifecycle.ts
 * receive only what they need.
 */

import type { ServerResponse } from 'node:http';
import type { AbortResult } from '../shared/execution-contracts.js';
import type { DiscussContext } from './discuss/context.js';
import type { EventBusEvents } from './event-bus.js';
import type { IdleTimer } from './idle-timer.js';
import type { ProgressStore } from './progress-store.js';
import type { CallerContext } from '../shared/request-context.js';
import type { SessionIndex } from './session-index.js';
import type { LifecycleState } from './server-types.js';
import type { ExecutionService } from './service.js';
import type { KbSubsystem } from './kb-tools.js';
import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../discuss/views.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Runtime } from './runtime.js';

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
  getKbSubsystem(): KbSubsystem | null;
  getKbInitError(): string | null;
  getLaunchFenceActive(): boolean;
}

export interface MutableBackendRuntimeState extends ReadonlyBackendRuntimeState {
  setLifecycle(state: LifecycleState): void;
  setStartedAt(ts: number): void;
  setKbSubsystem(kb: KbSubsystem | null): void;
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
  readonly runtime: Pick<Runtime, 'ids' | 'time'>;

  // Shared runtime state (read-only from HTTP perspective)
  readonly runtimeState: ReadonlyBackendRuntimeState;

  // Runtime services
  readonly idleTimer: IdleTimer;
  readonly progressStore: ProgressStore;
  readonly sessionIndex: SessionIndex;
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
  onSessionUpdated: (payload: EventBusEvents['session:updated']) => void;
  onDiscussUpdated: (payload: EventBusEvents['discuss:updated']) => void;
}
