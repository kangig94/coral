import type { ServerResponse } from 'node:http';
import type { CallerContext } from '../../shared/request-context.js';
import type { AbortResult } from '../../shared/execution-contracts.js';
import type { TypedEventBus } from './sse-subscribe.js';
import {
  jobAbortSchema,
  providerNameSchema,
  jobWaitSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionMessageSchema,
  workflowRequestSchema,
} from '../../shared/schemas.js';
import {
  belongsToNamespace,
  isLivePhase,
  jobPhaseSchema,
  type JobPhase,
  type JobProgressRecord,
  type JobStatusRecord,
  type JobTerminalRecord,
  type LaunchDecision,
  type WaitCursor,
  type WaitStreamEvent,
  type WaitStreamRequest,
} from '../../jobs/api.js';
import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../../discuss/api.js';
import type { ToolDomainResult } from './tool-response.js';

export {
  jobAbortSchema,
  providerNameSchema,
  jobWaitSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionMessageSchema,
  workflowRequestSchema,
  belongsToNamespace,
  isLivePhase,
  jobPhaseSchema,
};
export {
  buildCallerContextFromQuery,
  discussDeleteQuerySchema,
  discussDetailQuerySchema,
  discussEventsQuerySchema,
  kbMemoDeleteQuerySchema,
  kbMemoListQuerySchema,
  kbPrinciplesQuerySchema,
  kbSearchQuerySchema,
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

export type SessionStartInput = {
  prompt: string;
  agent?: string;
  model?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
};

export type SessionResumeInput = {
  sessionId: string;
  prompt: string;
  provider?: string;
  model?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
};

export type SessionForkInput = {
  sessionId: string;
  prompt?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
};

export type WorkflowPortInput = {
  expression: string;
  startPrompt: string;
  context?: string;
  provider: string;
  workDir?: string;
  owner?: string;
};

export type WorkflowPortResult =
  | { kind: 'decision'; decision: LaunchDecision }
  | { kind: 'invalid_request'; message: string; detail?: unknown };

export type ScopeCheckResult = {
  valid: string[];
  missing: string[];
  mismatch: string[];
};

export type JobListFilters = {
  projectRoot?: string;
  phase?: JobPhase;
  all?: boolean;
  provider?: string;
};

export type JobDetail = {
  status: JobStatusRecord;
  events: JobProgressRecord[];
};

export interface SessionRequestPort {
  start(providerName: string, input: SessionStartInput, ctx: CallerContext): Promise<LaunchDecision>;
  resumeBySessionId(input: SessionResumeInput, ctx: CallerContext): Promise<LaunchDecision>;
  forkBySessionId(input: SessionForkInput, ctx: CallerContext): Promise<LaunchDecision>;
}

export interface JobsRequestPort {
  scopeCheck(jobIds: string[], projectRoot: string): ScopeCheckResult;
  abort(jobIds: string[]): AbortResult;
  waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  list(filters: JobListFilters): Array<{ jobId: string; status: JobStatusRecord }>;
  detail(jobId: string): JobDetail | null;
}

export interface WorkflowRequestPort {
  execute(request: WorkflowPortInput, ctx: CallerContext): Promise<WorkflowPortResult>;
}

export interface KbRequestPort {
  readSearch(args: Record<string, unknown>): Promise<ToolDomainResult>;
  readNote(slug: string): ToolDomainResult;
  readSource(slug: string): ToolDomainResult;
  readCommunity(slug: string): ToolDomainResult;
  readMemo(slug: string, ctx: CallerContext): ToolDomainResult;
  readPrinciple(slug: string): ToolDomainResult;
  listSources(): Promise<ToolDomainResult>;
  listMemos(args: Record<string, unknown>, ctx: CallerContext): ToolDomainResult;
  listPrinciples(args: Record<string, unknown>): Promise<ToolDomainResult>;
  createNote(args: Record<string, unknown>, ctx: CallerContext): Promise<ToolDomainResult>;
  updateNote(args: Record<string, unknown>): Promise<ToolDomainResult>;
  deleteNote(slug: string): Promise<ToolDomainResult>;
  createSource(args: Record<string, unknown>): Promise<ToolDomainResult>;
  deleteSource(slug: string): Promise<ToolDomainResult>;
  createMemo(args: Record<string, unknown>, ctx: CallerContext): ToolDomainResult;
  deleteMemos(args: Record<string, unknown>, ctx: CallerContext): ToolDomainResult;
  reindex(): Promise<ToolDomainResult>;
}

export interface DiscussRequestPort {
  seed(args: unknown): ToolDomainResult;
  start(args: Record<string, unknown>, ctx: CallerContext): Promise<ToolDomainResult>;
  listSessions(): DiscussSummaryDto[];
  loadDetail(projectRoot: string, sessionId: string, view: DiscussView): DiscussDetailResponse | 'audit_requires_ended_session' | null;
  watch(args: Record<string, unknown>, ctx: CallerContext): ToolDomainResult;
  bid(args: Record<string, unknown>, ctx: CallerContext): Promise<ToolDomainResult>;
  speech(args: Record<string, unknown>, ctx: CallerContext): Promise<ToolDomainResult>;
  abort(args: Record<string, unknown>, ctx: CallerContext): Promise<ToolDomainResult>;
}

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
    result: JobTerminalRecord;
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

export interface HttpHandlerPorts {
  readonly identity: HandlerIdentity;
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly admin: AdminControlPort;
  readonly health: HealthSnapshotPort;
  readonly events: EventStreamPort;
  readonly sessions: SessionRequestPort;
  readonly jobs: JobsRequestPort;
  readonly workflows: WorkflowRequestPort;
  readonly kb: KbRequestPort;
  readonly discuss: DiscussRequestPort;
}

export type {
  CallerContext,
  DiscussDetailResponse,
  DiscussSummaryDto,
  DiscussView,
  JobPhase,
  JobProgressRecord,
  JobStatusRecord,
  JobTerminalRecord,
  LaunchDecision,
  WaitCursor,
  WaitStreamEvent,
  WaitStreamRequest,
};
