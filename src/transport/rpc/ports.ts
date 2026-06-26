import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../../discuss/read-contract.js';
import type { ExpansionRequestPort } from '../../expansion/rpc-contract.js';
import type { JobLaunchRequest, LaunchDecision } from '../../jobs/launch.js';
import type { JobPhase } from '../../jobs/phase.js';
import type { JobDetailResponse, JobStatus } from '../../jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../../jobs/wait.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { KbToolResult } from '../../kb/result.js';
import type { ToolDomainResult } from '../tool-result.js';

export type SessionStartInput = Pick<
  JobLaunchRequest,
  'prompt' | 'agent' | 'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt' | 'retention'
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

export interface SessionRequestPort {
  start(providerName: string, input: SessionStartInput, ctx: InvocationContext): Promise<LaunchDecision>;
}

export interface JobsRequestPort {
  scopeCheck(jobIds: string[], projectRoot: string): ScopeCheckResult;
  abort(jobIds: string[]): AbortResult;
  waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  list(filters: JobListFilters): Array<{ jobId: string; status: JobStatus }>;
  detail(jobId: string): JobDetailResponse | null;
}

export interface WorkflowRequestPort {
  execute(request: WorkflowPortInput, ctx: InvocationContext): Promise<WorkflowPortResult>;
}

type MaybePromise<T> = T | Promise<T>;

export interface KbRequestPort {
  readSearch(args: Record<string, unknown>): Promise<KbToolResult>;
  diagnose(): MaybePromise<KbToolResult>;
  readNote(slug: string): MaybePromise<KbToolResult>;
  readSource(slug: string): MaybePromise<KbToolResult>;
  readCommunity(slug: string): MaybePromise<KbToolResult>;
  listStaleCommunities(): MaybePromise<KbToolResult>;
  readCommunitySummaryInput(slug: string): MaybePromise<KbToolResult>;
  setCommunitySummary(args: Record<string, unknown>, ctx?: InvocationContext): Promise<KbToolResult>;
  readWiki(slug: string): MaybePromise<KbToolResult>;
  readMemo(slug: string, ctx: InvocationContext): MaybePromise<KbToolResult>;
  readPrinciple(slug: string): MaybePromise<KbToolResult>;
  listSources(): Promise<KbToolResult>;
  listWikis(): Promise<KbToolResult>;
  listMemos(args: Record<string, unknown>, ctx: InvocationContext): MaybePromise<KbToolResult>;
  listPrinciples(args: Record<string, unknown>): Promise<KbToolResult>;
  createNote(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  updateNote(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  deleteNote(slug: string, ctx?: InvocationContext): Promise<KbToolResult>;
  createWiki(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  rewriteWiki(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  linkWiki(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  unlinkWiki(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  citeWiki(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  adoptWiki(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  deleteWiki(slug: string, ctx?: InvocationContext): Promise<KbToolResult>;
  wakeUp(args: Record<string, unknown>): Promise<KbToolResult>;
  createSource(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  deleteSource(slug: string, ctx?: InvocationContext): Promise<KbToolResult>;
  createMemo(args: Record<string, unknown>, ctx: InvocationContext): MaybePromise<KbToolResult>;
  deleteMemos(args: Record<string, unknown>, ctx: InvocationContext): MaybePromise<KbToolResult>;
  reindex(request: Record<string, unknown>, ctx?: InvocationContext): Promise<KbToolResult>;
}

export interface DiscussRequestPort {
  seed(args: unknown): ToolDomainResult;
  start(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
  listSessions(): DiscussSummaryDto[];
  loadDetail(
    projectRoot: string,
    sessionId: string,
    view: DiscussView,
  ): DiscussDetailResponse | 'audit_requires_ended_session' | null;
  watch(args: Record<string, unknown>, ctx: InvocationContext): ToolDomainResult;
  bid(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
  speech(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
  abort(args: Record<string, unknown>, ctx: InvocationContext): Promise<ToolDomainResult>;
}

export interface RpcPorts {
  readonly sessions: SessionRequestPort;
  readonly jobs: JobsRequestPort;
  readonly workflows: WorkflowRequestPort;
  readonly kb: KbRequestPort;
  readonly discuss: DiscussRequestPort;
  readonly expansion: ExpansionRequestPort;
}
