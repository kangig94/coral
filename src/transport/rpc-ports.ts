import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../discuss/api.js';
import type {
  ListEquipmentRequest,
  ListEquipmentResult,
  RegisterEquipmentRequest,
  RegisterEquipmentResult,
  UnregisterEquipmentRequest,
  UnregisterResult,
} from '../coordinator/equipment/contract.js';
import type {
  JobForkRequest,
  JobLaunchRequest,
  JobPhase,
  JobProgress,
  JobResumeRequest,
  JobStatus,
  LaunchDecision,
  WaitStreamEvent,
  WaitStreamRequest,
} from '../jobs/api.js';
import type { CallerContext } from '../shared/request-context.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import type { ToolDomainResult } from '../shared/tool-domain-result.js';

export type SessionStartInput = Pick<
  JobLaunchRequest,
  'prompt' | 'agent' | 'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt'
>;

export type SessionResumeInput = Pick<
  JobResumeRequest,
  'sessionId' | 'prompt' | 'provider' | 'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt'
>;

export type SessionForkInput = Pick<
  JobForkRequest,
  'sessionId' | 'prompt' | 'provider' | 'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt'
>;

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
  status: JobStatus;
  events: JobProgress[];
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
  list(filters: JobListFilters): Array<{ jobId: string; status: JobStatus }>;
  detail(jobId: string): JobDetail | null;
}

export interface WorkflowRequestPort {
  execute(request: WorkflowPortInput, ctx: CallerContext): Promise<WorkflowPortResult>;
}

export interface KbRequestPort {
  readSearch(args: Record<string, unknown>): Promise<ToolDomainResult>;
  diagnose(): ToolDomainResult;
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

export interface EquipmentRequestPort {
  registerEquipment(request: RegisterEquipmentRequest): Promise<RegisterEquipmentResult>;
  unregisterEquipment(request: UnregisterEquipmentRequest): Promise<UnregisterResult>;
  listEquipment(request: ListEquipmentRequest): Promise<ListEquipmentResult>;
}

export interface RpcPorts {
  readonly sessions: SessionRequestPort;
  readonly jobs: JobsRequestPort;
  readonly workflows: WorkflowRequestPort;
  readonly kb: KbRequestPort;
  readonly discuss: DiscussRequestPort;
  readonly equipment: EquipmentRequestPort;
}
