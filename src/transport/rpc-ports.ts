import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../discuss/read-contract.js';
import type {
  ListEquipmentRequest,
  ListEquipmentResult,
  RegisterEquipmentRequest,
  RegisterEquipmentResult,
  UnregisterEquipmentRequest,
  UnregisterResult,
} from '../expansion/equipment-contract.js';
import type {
  JobForkRequest,
  JobLaunchRequest,
  JobResumeRequest,
  LaunchDecision,
} from '../jobs/launch.js';
import type { JobPhase } from '../jobs/phase.js';
import type { JobProgress, JobStatus } from '../jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../jobs/wait.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { AbortResult } from '../jobs/abort-result.js';
import type { KbToolResult } from '../kb/result.js';
import type { ToolDomainResult } from '../transport/tool-result.js';

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
  start(providerName: string, input: SessionStartInput, ctx: InvocationContext): Promise<LaunchDecision>;
  resumeBySessionId(input: SessionResumeInput, ctx: InvocationContext): Promise<LaunchDecision>;
  forkBySessionId(input: SessionForkInput, ctx: InvocationContext): Promise<LaunchDecision>;
}

export interface JobsRequestPort {
  scopeCheck(jobIds: string[], projectRoot: string): ScopeCheckResult;
  abort(jobIds: string[]): AbortResult;
  waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  list(filters: JobListFilters): Array<{ jobId: string; status: JobStatus }>;
  detail(jobId: string): JobDetail | null;
}

export interface WorkflowRequestPort {
  execute(request: WorkflowPortInput, ctx: InvocationContext): Promise<WorkflowPortResult>;
}

export interface KbRequestPort {
  readSearch(args: Record<string, unknown>): Promise<KbToolResult>;
  diagnose(): KbToolResult;
  readNote(slug: string): KbToolResult;
  readSource(slug: string): KbToolResult;
  readCommunity(slug: string): KbToolResult;
  readMemo(slug: string, ctx: InvocationContext): KbToolResult;
  readPrinciple(slug: string): KbToolResult;
  listSources(): Promise<KbToolResult>;
  listMemos(args: Record<string, unknown>, ctx: InvocationContext): KbToolResult;
  listPrinciples(args: Record<string, unknown>): Promise<KbToolResult>;
  createNote(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  updateNote(args: Record<string, unknown>): Promise<KbToolResult>;
  deleteNote(slug: string): Promise<KbToolResult>;
  createSource(args: Record<string, unknown>): Promise<KbToolResult>;
  deleteSource(slug: string): Promise<KbToolResult>;
  createMemo(args: Record<string, unknown>, ctx: InvocationContext): KbToolResult;
  deleteMemos(args: Record<string, unknown>, ctx: InvocationContext): KbToolResult;
  reindex(): Promise<KbToolResult>;
}

export interface DiscussRequestPort {
  seed(args: unknown): ToolDomainResult;
  start(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
  listSessions(): DiscussSummaryDto[];
  loadDetail(projectRoot: string, sessionId: string, view: DiscussView): DiscussDetailResponse | 'audit_requires_ended_session' | null;
  watch(args: Record<string, unknown>, ctx: InvocationContext): ToolDomainResult;
  bid(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
  speech(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
  abort(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
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
