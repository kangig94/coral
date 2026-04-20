import type { ServerResponse } from 'node:http';
import type { CallerContext } from '../../shared/request-context.js';
import type { TypedEventBus } from '../../coordinator/event-bus.js';
import {
  discussDeleteQuerySchema,
  discussDetailQuerySchema,
  discussEventsQuerySchema,
  type DiscussDetailResponse,
  type DiscussSummaryDto,
  type DiscussView,
} from '../../discuss/api.js';
import {
  belongsToNamespace,
  isLivePhase,
  jobPhaseSchema,
  type JobPhase,
  type JobProgress,
  type JobStatus,
  type JobTerminal,
  type LaunchDecision,
  type WaitCursor,
  type WaitStreamEvent,
  type WaitStreamRequest,
} from '../../jobs/api.js';
import {
  kbMemoDeleteQuerySchema,
  kbMemoListQuerySchema,
  kbPrinciplesQuerySchema,
  kbSearchQuerySchema,
} from '../../kb/api.js';
import type { RpcPorts } from '../rpc-ports.js';

export {
  discussDeleteQuerySchema,
  discussDetailQuerySchema,
  discussEventsQuerySchema,
  kbMemoDeleteQuerySchema,
  kbMemoListQuerySchema,
  kbPrinciplesQuerySchema,
  kbSearchQuerySchema,
  belongsToNamespace,
  isLivePhase,
  jobPhaseSchema,
};
export {
  buildCallerContextFromQuery,
  queryParamsToObject,
} from './query-coerce.js';
export {
  deriveErrorMessage,
  domainError,
  domainResultToHttp,
  formatZodError,
  launchToHttp,
  type ToolDomainResult,
} from './tool-response.js';
export type {
  DiscussRequestPort,
  JobDetail,
  JobListFilters,
  JobsRequestPort,
  KbRequestPort,
  RpcPorts,
  ScopeCheckResult,
  SessionForkInput,
  SessionRequestPort,
  SessionResumeInput,
  SessionStartInput,
  WorkflowPortInput,
  WorkflowPortResult,
  WorkflowRequestPort,
} from '../rpc-ports.js';

export interface AdminControlPort {
  isLifecycleRunning(): boolean;
  isDrainRequested(): boolean;
  isLaunchFenceActive(): boolean;
  beginRequest(): void;
  endRequest(): void;
  requestDrain(reason: string): void;
}

export type HealthSnapshot = {
  status: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  uptimeMs: number;
  active: number;
  activeJobs: number;
  liveDiscuss: number;
  queueDepth: number;
  inflightRequests: number;
  env: Record<string, string>;
  subsystems: {
    kb: 'ok' | 'unavailable';
    kbError?: string;
    discuss: 'ok';
  };
};

export interface HealthSnapshotPort {
  read(): HealthSnapshot;
}

export interface EventStreamHandlers {
  onJobCreated: (payload: { jobId: string; sessionId: string; provider: string; projectRoot: string }) => void;
  onPhaseChanged: (payload: { jobId: string; phase: JobPhase; previousPhase: JobPhase }) => void;
  onProgress: (payload: { jobId: string; eventId: number; message: string }) => void;
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

export interface EventStreamPort {
  readonly bus: TypedEventBus;
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

export type {
  CallerContext,
  DiscussDetailResponse,
  DiscussSummaryDto,
  DiscussView,
  JobPhase,
  JobProgress,
  JobStatus,
  JobTerminal,
  LaunchDecision,
  WaitCursor,
  WaitStreamEvent,
  WaitStreamRequest,
};
