import type { WaitAdmission, WaitSnapshot } from '../../jobs/wait/session.js';
import type { WaitSnapshotRequest } from '../../jobs/wait/contract.js';
import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../../discuss/read-contract.js';
import type { ExpansionRequestPort } from '../../expansion/rpc-contract.js';
import type { JobLaunchRequest, ProviderSessionLaunchDecision, WorkflowLaunchDecision } from '../../jobs/launch.js';
import type { JobsReleaseResult } from '../../jobs/records.js';
import type { JobStatus } from '../../jobs/records.js';
import type { WaitStreamEvent, CanonicalWaitStreamRequest } from '../../jobs/wait/contract.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { Principal } from '../../security/principal.js';
import type { AbortDecision } from '../../jobs/contracts/abort-registry.js';
import type { KbToolResult } from '../../kb/result.js';
import type { DiscussToolResult } from '../../discuss/result.js';
import type { RecoveryQuarantineClearRequest, RecoveryQuarantineClearResult } from '../../recovery/source-registry.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { HostRef } from '../../providers/host-inventory-schema.js';
import type {
  ProviderHostEvictResponse,
  ProviderHostInspectResponse,
  ProviderHostListV2Response,
  ProviderProxySetContainBooleanRequest,
  ProviderProxySetContainBooleanResponse,
  ProviderProxySetContainRequest,
  ProviderProxySetContainResponse,
} from './catalog.js';
import type {
  UnreadableProviderOperationDiscardRequest,
  UnreadableProviderOperationDiscardResult,
} from '../../recovery/unreadable-provider-operation.js';
import type { JobScopeRelation, ScopeCheckResult } from '../../jobs/scope.js';
import type { JobsListFilters } from '../../jobs/read-queries.js';
import type { JobDetailLookup } from '../../jobs/contracts/addressing.js';

type SessionStartInput = Pick<
  JobLaunchRequest,
  'prompt' | 'agent' | 'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt' | 'retention' | 'jobId'
>;

export type WorkflowPortInput = {
  expression: string;
  startPrompt: string;
  context?: string;
  provider: string;
  workDir: CanonicalWorkDir;
  owner?: string;
};

type WorkflowPortResult =
  | { kind: 'decision'; decision: WorkflowLaunchDecision }
  | { kind: 'invalid_request'; message: string; detail?: unknown };

interface SessionRequestPort {
  start(
    providerName: string,
    input: SessionStartInput,
    ctx: InvocationContext,
    signal?: AbortSignal,
  ): Promise<ProviderSessionLaunchDecision>;
}

interface JobsRequestPort {
  admitWait(req: CanonicalWaitStreamRequest): WaitAdmission[];
  snapshot(req: WaitSnapshotRequest): WaitSnapshot;
  scopeCheck(jobIds: string[], callerRoot: CanonicalWorkDir, relation: JobScopeRelation): ScopeCheckResult;
  abort(jobIds: string[]): AbortDecision;
  release(jobIds: string[]): JobsReleaseResult;
  waitStream(req: CanonicalWaitStreamRequest): AsyncGenerator<WaitStreamEvent>;

  waitHandoverSignal(): AbortSignal;
  list(filters: JobsListFilters): Array<{ jobId: string; status: JobStatus; released?: boolean }>;
  detail(jobId: string): JobDetailLookup;
  unknownJobDisposition(): 'pre-epoch-history' | 'not-found' | 'discovery-unknown' | 'discovery-unreadable';
  unknownJobCaveat?(): string;
}

interface WorkflowRequestPort {
  execute(request: WorkflowPortInput, ctx: InvocationContext, signal?: AbortSignal): Promise<WorkflowPortResult>;
}

export interface RecoveryQuarantineRequestPort {
  clear(request: RecoveryQuarantineClearRequest, signal?: AbortSignal): Promise<RecoveryQuarantineClearResult>;
  discardProviderOperation?(
    request: UnreadableProviderOperationDiscardRequest,
  ): Promise<UnreadableProviderOperationDiscardResult> | UnreadableProviderOperationDiscardResult;
}

export interface ProviderHostRequestPort {
  list(): Promise<ProviderHostListV2Response>;
  inspect(
    selector: Readonly<{ hostRef: HostRef }> | Readonly<{ workDir: CanonicalWorkDir }>,
  ): Promise<ProviderHostInspectResponse>;
  evict(
    selector: Readonly<{ hostRef: HostRef }> | Readonly<{ workDir: CanonicalWorkDir }>,
    signal?: AbortSignal,
  ): Promise<ProviderHostEvictResponse>;
}

export interface ProviderProxySetRequestPort {
  contain(request: ProviderProxySetContainRequest, signal?: AbortSignal): Promise<ProviderProxySetContainResponse>;
  containBoolean(
    request: ProviderProxySetContainBooleanRequest,
    signal?: AbortSignal,
  ): Promise<ProviderProxySetContainBooleanResponse | Readonly<{ kind: 'unsupported-contract' }>>;
}

type MaybePromise<T> = T | Promise<T>;

export interface KbRequestPort {
  readSearch(args: Record<string, unknown>, principal: Principal): Promise<KbToolResult>;
  diagnose(principal: Principal): MaybePromise<KbToolResult>;
  readNote(slug: string, principal: Principal): MaybePromise<KbToolResult>;
  readSource(slug: string, principal: Principal): MaybePromise<KbToolResult>;
  readCommunity(slug: string, principal: Principal): MaybePromise<KbToolResult>;
  listStaleCommunities(principal: Principal): MaybePromise<KbToolResult>;
  readCommunitySummaryInput(slug: string, principal: Principal): MaybePromise<KbToolResult>;
  setCommunitySummary(
    args: Record<string, unknown>,
    ctx?: InvocationContext,
    signal?: AbortSignal,
  ): Promise<KbToolResult>;
  readWiki(slug: string, principal: Principal): MaybePromise<KbToolResult>;
  readMemo(slug: string, ctx: InvocationContext): MaybePromise<KbToolResult>;
  readPrinciple(slug: string, principal: Principal): MaybePromise<KbToolResult>;
  listSources(principal: Principal): Promise<KbToolResult>;
  listWikis(principal: Principal): Promise<KbToolResult>;
  listMemos(args: Record<string, unknown>, ctx: InvocationContext): MaybePromise<KbToolResult>;
  listPrinciples(args: Record<string, unknown>, principal: Principal): Promise<KbToolResult>;
  createNote(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  updateNote(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  deleteNote(slug: string, ctx?: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  createWiki(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  rewriteWiki(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  linkWiki(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  unlinkWiki(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  citeWiki(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  adoptWiki(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  deleteWiki(slug: string, ctx?: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  wakeUp(args: Record<string, unknown>, principal: Principal, signal?: AbortSignal): Promise<KbToolResult>;
  createSource(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  deleteSource(slug: string, ctx?: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
  createMemo(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): MaybePromise<KbToolResult>;
  deleteMemos(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): MaybePromise<KbToolResult>;
  reindex(request: Record<string, unknown>, ctx?: InvocationContext, signal?: AbortSignal): Promise<KbToolResult>;
}

interface DiscussRequestPort {
  seed(args: unknown): DiscussToolResult;
  start(args: Record<string, unknown>, ctx: InvocationContext, signal?: AbortSignal): Promise<DiscussToolResult>;
  listSessions(): DiscussSummaryDto[];
  loadDetail(
    projectRoot: string,
    sessionId: string,
    view: DiscussView,
  ): DiscussDetailResponse | 'audit_requires_ended_session' | null;
  watch(args: Record<string, unknown>, ctx: InvocationContext): DiscussToolResult;
  bid(args: Record<string, unknown>, ctx: InvocationContext): Promise<DiscussToolResult>;
  speech(args: Record<string, unknown>, ctx: InvocationContext): Promise<DiscussToolResult>;
  abort(args: Record<string, unknown>, ctx: InvocationContext): Promise<DiscussToolResult>;
}

export interface RpcPorts {
  readonly sessions: SessionRequestPort;
  readonly jobs: JobsRequestPort;
  readonly workflows: WorkflowRequestPort;
  readonly recoveryQuarantine: RecoveryQuarantineRequestPort;
  readonly providerHosts?: ProviderHostRequestPort;
  readonly providerProxySets?: ProviderProxySetRequestPort;
  readonly kb: KbRequestPort;
  readonly discuss: DiscussRequestPort;
  readonly expansion: ExpansionRequestPort;
}
