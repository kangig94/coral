import { resolveDiscoveredCoordinator as defaultEnsureCoordinator, withAbortTimeout, type CoordinatorHandle } from './coordinator/handle.js';
import type { CoordinatorHealth } from './coordinator/health.js';
import { isCoordinatorHealth } from './coordinator/health.js';
import { throwCoordinatorCommunicationError } from './coordinator/communication.js';
import { CoordinatorHttpError } from './errors.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type {
  DiscussDetailResponse,
  DiscussSummaryDto,
  DiscussView,
} from '../../discuss/read-contract.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '../../discuss/session-types.js';
import type { WatchState } from '../../discuss/watch.js';
import type {
  KbDeleteInput,
  KbMemoDeleteInput,
  KbMemoDeleteResult,
  KbMemoInput,
  KbMemoListInput,
  KbMemoListResult,
  KbMemoPurgeInput,
  KbMemoPurgeResult,
  KbPrinciplesInput,
  KbPrinciplesResult,
  KbPromoteInput,
  KbReadInput,
  KbReadResult,
  KbReindexInput,
  KbSearchInput,
  KbSearchResponse,
  KbSourceDeleteInput,
  KbSourceListResult,
  KbSourcePersistInput,
  KbUpdateInput,
  ReindexResult,
} from '../../kb/entry-types.js';
import type { EffortLevel } from '../../providers/request-policy.js';
import {
  KB_BARE_READ_ORDER,
  isKbMemoCandidateSlug,
  parseKbSelector,
  type KbReadKind,
} from '../../kb/selector.js';
import {
  describeHttpError,
  HEALTH_TIMEOUT_MS,
  parseJsonResponse,
  parseSseBlock,
  TOOL_TIMEOUT_MS,
} from './sse.js';
import type { JobProgress, JobStatus } from '../../jobs/records.js';
import type { WaitCursor, WaitStreamEvent } from '../../jobs/wait.js';
import { parseWaitStreamEvent } from '../../jobs/wait-stream-event.js';
import { isRecord } from '../../infra/json.js';

export type AcceptedLaunchResponse = {
  session: string;
  job: string;
  launchState: 'running' | 'queued';
};

export type SessionCreateResponse = AcceptedLaunchResponse;
export type SessionMessageResponse = AcceptedLaunchResponse;
export type SessionForkResponse = AcceptedLaunchResponse;
export type WorkflowLaunchResponse = AcceptedLaunchResponse;

export type JobsListResponse = {
  jobs: Array<{ jobId: string; status: JobStatus }>;
};

export type ListJobsOptions = {
  projectRoot?: string;
  phase?: string;
  all?: boolean;
  provider?: string;
};

export type JobDetailResponse = {
  status: JobStatus;
  events: JobProgress[];
};

export type DiscussStartResponse = {
  session: string;
};

export type DiscussAbortResponse = {
  ok: true;
  session: string;
};

export type DiscussSessionsListResponse = {
  sessions: DiscussSummaryDto[];
};

export type KbMemoResponse = {
  filename: string;
  path: string;
};

export type KbPromoteResponse = {
  path: string;
};

export type KbUpdateResponse = {
  path: string;
};

export type KbDeleteResponse = {
  deleted: string;
};

export type KbSourceImportResponse = {
  status: 'completed';
  job: string;
  readiness: 'commit' | 'base-search' | 'active-vector' | 'all-equipped';
  slug: string;
  path: string;
} | {
  status: 'running' | 'queued';
  job: string;
  readiness: 'commit' | 'base-search' | 'active-vector' | 'all-equipped';
};

export type KbSourceDeleteResponse = {
  deleted: string;
};

type SessionRequestOptions = {
  context?: InvocationContext;
  provider?: string;
  model?: string;
  workDir?: string;
  owner?: string;
  effort?: EffortLevel;
  claudeModelCap?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
};

type CreateSessionOptions = SessionRequestOptions & {
  agent?: string;
};

type WaitJobsOptions = {
  context?: InvocationContext;
  timeoutSeconds?: number;
  cursor?: WaitCursor;
};

type WorkflowOptions = {
  startPrompt: string;
  context?: string;
  provider?: string;
  workDir?: string;
  owner?: string;
  claudeModelCap?: string;
};

export { isCoordinatorHealth };
export type { CoordinatorHealth };
export { CoordinatorHttpError } from './errors.js';
export type { InvocationContext } from '../../runtime/invocation-context.js';

export class CoordinatorClient {
  private readonly ensureBackendHandle: (pluginRoot?: string) => Promise<CoordinatorHandle>;
  private readonly defaultContext?: InvocationContext;
  private readonly defaultPluginRoot?: string;

  constructor(
    options: {
      ensureBackend?: (pluginRoot?: string) => Promise<CoordinatorHandle>;
      defaultContext?: InvocationContext;
    } = {},
  ) {
    this.defaultContext = options.defaultContext
      ? {
          projectRoot: options.defaultContext.projectRoot,
          pluginRoot: options.defaultContext.pluginRoot,
          coralEnv: { ...options.defaultContext.coralEnv },
        }
      : undefined;
    this.defaultPluginRoot = this.defaultContext?.pluginRoot;
    this.ensureBackendHandle =
      options.ensureBackend ?? ((pluginRoot?: string) => defaultEnsureCoordinator(pluginRoot ?? this.defaultPluginRoot));
  }

  async createSession(
    provider: string,
    prompt: string,
    options: CreateSessionOptions = {},
  ): Promise<SessionCreateResponse> {
    const { context, ...request } = options;
    return this.postRoute(
      '/sessions',
      {
        provider,
        prompt,
        ...request,
      },
      this.resolveContext(context),
    );
  }

  async sendMessage(
    sessionId: string,
    prompt: string,
    options: SessionRequestOptions = {},
  ): Promise<SessionMessageResponse> {
    const { context, ...request } = options;
    return this.postRoute(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        prompt,
        ...request,
      },
      this.resolveContext(context),
    );
  }

  async forkSession(
    sessionId: string,
    prompt?: string,
    options: SessionRequestOptions = {},
  ): Promise<SessionForkResponse> {
    const { context, ...request } = options;
    return this.postRoute(
      `/sessions/${encodeURIComponent(sessionId)}/forks`,
      prompt === undefined ? request : { prompt, ...request },
      this.resolveContext(context),
    );
  }

  async waitJobs(jobIds: string[], options: WaitJobsOptions = {}): Promise<ReadableStream<WaitStreamEvent>> {
    const { context, ...request } = options;
    const ctx = this.resolveContext(context);
    const { port, host, token } = await this.resolveBackendHandle(ctx);
    const body = JSON.stringify(
      this.buildRequestBody(
        {
          jobIds,
          ...request,
        },
        ctx,
      ),
    );

    try {
      const response = await fetch(`http://${host}:${port}/jobs/wait`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Coordinator-Token': token,
        },
        body,
      });
      const responseBody = response.ok ? undefined : await parseJsonResponse(response);

      if (!response.ok) {
        throw new CoordinatorHttpError(this.describeError(response, responseBody), response.status, responseBody);
      }

      if (!response.body) {
        throw new Error('Backend wait stream returned no response body');
      }

      return this.createWaitStream(response.body);
    } catch (error) {
      throwCoordinatorCommunicationError(error);
    }
  }

  async abortJobs(jobIds: string[], context?: InvocationContext): Promise<AbortResult> {
    return this.postRoute('/jobs/abort', { jobs: jobIds }, this.resolveContext(context));
  }

  async listJobs(options: ListJobsOptions = {}, context?: InvocationContext): Promise<JobsListResponse> {
    const ctx = this.resolveContext(context, 'job list');
    return this.getRoute(
      this.buildRoutePath('/jobs', {
        projectRoot: options.projectRoot ?? ctx.projectRoot,
        phase: options.phase,
        all: options.all ? '1' : undefined,
        provider: options.provider,
      }),
      ctx,
    );
  }

  async getJob(jobId: string): Promise<JobDetailResponse> {
    return this.getRoute(`/jobs/${encodeURIComponent(jobId)}`);
  }

  async workflow(expression: string, options: WorkflowOptions): Promise<WorkflowLaunchResponse>;
  async workflow(
    expression: string,
    context: InvocationContext,
    options: WorkflowOptions,
  ): Promise<WorkflowLaunchResponse>;
  async workflow(
    expression: string,
    contextOrOptions: InvocationContext | WorkflowOptions,
    maybeOptions?: WorkflowOptions,
  ): Promise<WorkflowLaunchResponse> {
    const invocationContext = maybeOptions === undefined ? undefined : (contextOrOptions as InvocationContext);
    const options = maybeOptions ?? (contextOrOptions as WorkflowOptions);

    return this.postRoute(
      '/workflow',
      {
        expression,
        ...options,
      },
      this.resolveContext(invocationContext),
    );
  }

  async discussSeed(
    args: {
      controversy_axes: Array<{ axis: string; positions: string[] }>;
      n: number;
      seed: number;
      demographics?: { origin_weights: Record<string, number>; outlier_ratio?: number };
    },
    context?: InvocationContext,
  ): Promise<PersonaSeedOutput> {
    return this.postRoute('/discuss/persona-sets', args, context, { injectContext: false });
  }

  async discussStart(
    args: {
      topic: string;
      agents: Array<{
        name: string;
        persona: string;
        participation?: string;
        provider?: string;
        model?: string;
      }>;
      config?: { min_bid_delay_ms?: number };
    },
    context?: InvocationContext,
  ): Promise<DiscussStartResponse> {
    return this.postRoute('/discuss/sessions', args, this.resolveContext(context, 'discuss session creation'));
  }

  async discussWatch(session: string, context?: InvocationContext): Promise<WatchState>;
  async discussWatch(session: string, cursor?: number, context?: InvocationContext): Promise<WatchState>;
  async discussWatch(
    session: string,
    cursorOrContext?: number | InvocationContext,
    maybeContext?: InvocationContext,
  ): Promise<WatchState> {
    const cursor = typeof cursorOrContext === 'number' ? cursorOrContext : undefined;
    const context = typeof cursorOrContext === 'number' ? maybeContext : cursorOrContext;
    const ctx = this.resolveContext(context, 'discuss watch');
    return this.getRoute(
      this.buildRoutePath(`/discuss/sessions/${encodeURIComponent(session)}/events`, {
        projectRoot: ctx.projectRoot,
        cursor,
      }),
      ctx,
    );
  }

  async discussBid(
    args: {
      session: string;
      agent_name: string;
      score: number;
      thought: string;
    },
    context?: InvocationContext,
  ): Promise<BidResult> {
    const { session, ...body } = args;
    return this.postRoute(
      `/discuss/sessions/${encodeURIComponent(session)}/bids`,
      body,
      this.resolveContext(context, 'discuss bid'),
    );
  }

  async discussSpeech(
    args: {
      session: string;
      agent_name: string;
      content: string;
    },
    context?: InvocationContext,
  ): Promise<SpeechResult> {
    const { session, ...body } = args;
    return this.postRoute(
      `/discuss/sessions/${encodeURIComponent(session)}/speeches`,
      body,
      this.resolveContext(context, 'discuss speech'),
    );
  }

  async discussAbort(session: string, context?: InvocationContext): Promise<DiscussAbortResponse> {
    const ctx = this.resolveContext(context, 'discuss abort');
    return this.deleteRoute(
      this.buildRoutePath(`/discuss/sessions/${encodeURIComponent(session)}`, {
        projectRoot: ctx.projectRoot,
      }),
      ctx,
    );
  }

  async listDiscussSessions(context?: InvocationContext): Promise<DiscussSessionsListResponse> {
    return this.getRoute('/discuss/sessions', context);
  }

  async getDiscussSession(id: string, context?: InvocationContext): Promise<DiscussDetailResponse>;
  async getDiscussSession(
    id: string,
    view?: DiscussView,
    context?: InvocationContext,
  ): Promise<DiscussDetailResponse>;
  async getDiscussSession(
    id: string,
    viewOrContext?: DiscussView | InvocationContext,
    maybeContext?: InvocationContext,
  ): Promise<DiscussDetailResponse> {
    const view = typeof viewOrContext === 'string' ? viewOrContext : undefined;
    const context = typeof viewOrContext === 'string' ? maybeContext : viewOrContext;
    const ctx = this.resolveContext(context, 'discuss session detail');
    return this.getRoute(
      this.buildRoutePath(`/discuss/sessions/${encodeURIComponent(id)}`, {
        projectRoot: ctx.projectRoot,
        view,
      }),
      ctx,
    );
  }

  async kbSearch(args: KbSearchInput, context?: InvocationContext): Promise<KbSearchResponse> {
    return this.getRoute(
      this.buildRoutePath('/kb/entries', {
        q: args.query,
        scope: args.scope,
        top_k: args.top_k,
        mode: args.mode,
      }),
      context,
    );
  }

  async kbPrinciples(args: KbPrinciplesInput, context?: InvocationContext): Promise<KbPrinciplesResult> {
    return this.getRoute(
      this.buildRoutePath('/kb/principles', {
        q: args.query,
        top_k: args.top_k,
        verbose: args.verbose,
      }),
      context,
    );
  }

  async kbRead(args: KbReadInput, context?: InvocationContext): Promise<KbReadResult> {
    const selector = parseKbSelector(args.note);
    if (selector.kind !== null) {
      return this.kbReadByKind(selector.kind, selector.slug, context);
    }

    const ctx = this.resolveContext(context, 'bare KB reads');
    let lastNotFound: CoordinatorHttpError | null = null;

    for (const kind of KB_BARE_READ_ORDER) {
      if (kind === 'memo' && !isKbMemoCandidateSlug(selector.slug)) {
        continue;
      }

      try {
        return await this.kbReadByKind(kind, selector.slug, ctx);
      } catch (error) {
        if (error instanceof CoordinatorHttpError && error.statusCode === 404) {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }

    if (lastNotFound) {
      throw lastNotFound;
    }

    throw new Error(`KB entry not found: ${args.note}`);
  }

  async kbPromote(args: KbPromoteInput, context?: InvocationContext): Promise<KbPromoteResponse> {
    const ctx = this.resolveContext(context, 'kb note creation');
    return this.postRoute('/kb/notes', this.addHostedJobContext(args, ctx), ctx);
  }

  async kbUpdate(args: KbUpdateInput, context?: InvocationContext): Promise<KbUpdateResponse> {
    const { note, ...body } = args;
    const ctx = this.resolveContext(context, 'kb note update');
    return this.putRoute(`/kb/notes/${encodeURIComponent(note)}`, this.addHostedJobContext(body, ctx), ctx);
  }

  async kbDelete(args: KbDeleteInput, context?: InvocationContext): Promise<KbDeleteResponse> {
    const ctx = this.resolveContext(context, 'kb note delete');
    return this.deleteRoute(this.buildKbMutationDeletePath(`/kb/notes/${encodeURIComponent(args.note)}`, ctx), ctx);
  }

  async kbSourceImport(args: KbSourcePersistInput, context?: InvocationContext): Promise<KbSourceImportResponse> {
    const ctx = this.resolveContext(context, 'kb source import');
    return this.postRoute('/kb/sources', this.addHostedJobContext(args, ctx), ctx);
  }

  async kbSourceList(context?: InvocationContext): Promise<KbSourceListResult> {
    return this.getRoute('/kb/sources', context);
  }

  async kbSourceDelete(args: KbSourceDeleteInput, context?: InvocationContext): Promise<KbSourceDeleteResponse> {
    const ctx = this.resolveContext(context, 'kb source delete');
    return this.deleteRoute(this.buildKbMutationDeletePath(`/kb/sources/${encodeURIComponent(args.slug)}`, ctx), ctx);
  }

  async kbMemo(args: KbMemoInput, context?: InvocationContext): Promise<KbMemoResponse> {
    const ctx = this.resolveContext(context, 'kb memo creation');
    return this.postRoute('/kb/memos', this.addHostedJobContext(args, ctx), ctx);
  }

  async kbMemoList(args: KbMemoListInput, context?: InvocationContext): Promise<KbMemoListResult> {
    const ctx = this.resolveContext(context, 'kb memo list');
    return this.getRoute(
      this.buildRoutePath('/kb/memos', {
        projectRoot: ctx.projectRoot,
        owner: this.resolveMemoOwner(args.owner, ctx),
      }),
      ctx,
    );
  }

  async kbMemoDelete(args: KbMemoDeleteInput, context?: InvocationContext): Promise<KbMemoDeleteResult> {
    const ctx = this.resolveContext(context, 'kb memo delete');
    return this.deleteRoute(
      this.buildRoutePath('/kb/memos', {
        projectRoot: ctx.projectRoot,
        pattern: args.pattern,
        owner: this.resolveMemoOwner(args.owner, ctx),
        jobId: ctx.coralEnv.CORAL_JOB_ID,
        sessionId: ctx.coralEnv.CORAL_SESSION_ID,
      }),
      ctx,
    );
  }

  async kbMemoPurge(args: KbMemoPurgeInput, context?: InvocationContext): Promise<KbMemoPurgeResult> {
    const ctx = this.resolveContext(context, 'kb memo purge');
    return this.deleteRoute(
      this.buildRoutePath('/kb/memos', {
        projectRoot: ctx.projectRoot,
        all: true,
        owner: this.resolveMemoOwner(args.owner, ctx),
        jobId: ctx.coralEnv.CORAL_JOB_ID,
        sessionId: ctx.coralEnv.CORAL_SESSION_ID,
      }),
      ctx,
    );
  }

  async kbReindex(args: KbReindexInput = {}, context?: InvocationContext): Promise<ReindexResult> {
    void args;
    const ctx = this.resolveContext(context, 'kb reindex');
    return this.postRoute('/kb/index', this.addHostedJobContext({}, ctx), ctx);
  }

  async health(): Promise<CoordinatorHealth | null> {
    const { port, host, token } = await this.resolveBackendHandle();

    try {
      const response = await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) =>
        fetch(`http://${host}:${port}/health`, {
          method: 'GET',
          headers: { 'X-Coral-Coordinator-Token': token },
          signal,
        }),
      );

      if (!response.ok) {
        return null;
      }

      const body = await parseJsonResponse(response);
      return isCoordinatorHealth(body) ? body : null;
    } catch {
      return null;
    }
  }

  async shutdown(): Promise<{ ok: boolean }> {
    const { port, host, token } = await this.resolveBackendHandle();

    try {
      const response = await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) =>
        fetch(`http://${host}:${port}/admin/shutdown`, {
          method: 'POST',
          headers: { 'X-Coral-Coordinator-Token': token },
          signal,
        }),
      );

      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }

  private resolveContext(context?: InvocationContext, operation = 'backend tool calls'): InvocationContext {
    const resolvedContext = context ?? this.defaultContext;
    if (resolvedContext) return resolvedContext;
    throw new Error(`InvocationContext is required for ${operation}`);
  }

  private resolveBackendHandle(context?: InvocationContext): Promise<CoordinatorHandle> {
    const pluginRoot = context?.pluginRoot ?? this.defaultPluginRoot;
    return this.ensureBackendHandle(pluginRoot);
  }

  private buildRequestBody(args: Record<string, unknown>, ctx: InvocationContext): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...args,
      projectRoot: ctx.projectRoot,
    };

    const owner = ctx.coralEnv.CORAL_OWNER;
    const effort = ctx.coralEnv.CORAL_EFFORT;
    const claudeModelCap = ctx.coralEnv.CORAL_CLAUDE_MODEL_CAP;

    if (body.owner === undefined && typeof owner === 'string' && owner.length > 0) {
      body.owner = owner;
    }
    if (body.effort === undefined && typeof effort === 'string' && effort.length > 0) {
      body.effort = effort;
    }
    if (body.claudeModelCap === undefined && typeof claudeModelCap === 'string' && claudeModelCap.length > 0) {
      body.claudeModelCap = claudeModelCap;
    }

    return body;
  }

  private addHostedJobContext(args: Record<string, unknown>, ctx: InvocationContext): Record<string, unknown> {
    const body = { ...args };
    const jobId = ctx.coralEnv.CORAL_JOB_ID;
    const sessionId = ctx.coralEnv.CORAL_SESSION_ID;

    if (body.jobId === undefined && typeof jobId === 'string' && jobId.length > 0) {
      body.jobId = jobId;
    }
    if (body.sessionId === undefined && typeof sessionId === 'string' && sessionId.length > 0) {
      body.sessionId = sessionId;
    }

    return body;
  }

  private buildKbMutationDeletePath(path: string, ctx: InvocationContext): string {
    const jobId = ctx.coralEnv.CORAL_JOB_ID;
    const sessionId = ctx.coralEnv.CORAL_SESSION_ID;
    if (typeof jobId !== 'string' || jobId.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) {
      return path;
    }

    return this.buildRoutePath(path, {
      projectRoot: ctx.projectRoot,
      jobId,
      sessionId,
    });
  }

  private buildRoutePath(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): string {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    const queryString = params.toString();
    return queryString.length > 0 ? `${path}?${queryString}` : path;
  }

  private resolveMemoOwner(owner: string | undefined, ctx: InvocationContext): string | undefined {
    if (owner !== undefined) {
      return owner;
    }

    const fallback = ctx.coralEnv.CORAL_OWNER;
    return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined;
  }

  private describeError(response: Response, responseBody: unknown): string {
    if (isRecord(responseBody) && typeof responseBody.message === 'string' && responseBody.message.length > 0) {
      return responseBody.message;
    }

    return describeHttpError(response.status, response.statusText);
  }

  private async requestRoute<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    handle: CoordinatorHandle,
    body?: string,
  ): Promise<T> {
    const { port, host, token } = handle;
    const headers: Record<string, string> = {
      'X-Coral-Coordinator-Token': token,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
        const request: RequestInit = {
          method,
          headers,
          signal,
        };

        if (body !== undefined) {
          request.body = body;
        }

        const response = await fetch(`http://${host}:${port}${path}`, request);
        const responseBody = await parseJsonResponse(response);

        if (response.ok) {
          return responseBody as T;
        }

        throw new CoordinatorHttpError(this.describeError(response, responseBody), response.status, responseBody);
      });
    } catch (error) {
      throwCoordinatorCommunicationError(error);
    }
  }

  private async getRoute<T>(path: string, context?: InvocationContext): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    return this.requestRoute('GET', path, handle);
  }

  private async putRoute<T>(
    path: string,
    args: Record<string, unknown>,
    context?: InvocationContext,
    options: { injectContext?: boolean } = {},
  ): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    const payload = context && options.injectContext !== false ? this.buildRequestBody(args, context) : args;
    const body = JSON.stringify(payload);
    return this.requestRoute('PUT', path, handle, body);
  }

  private async deleteRoute<T>(path: string, context?: InvocationContext): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    return this.requestRoute('DELETE', path, handle);
  }

  private async postRoute<T>(
    path: string,
    args: Record<string, unknown>,
    context?: InvocationContext,
    options: { injectContext?: boolean } = {},
  ): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    const payload = context && options.injectContext !== false ? this.buildRequestBody(args, context) : args;
    const body = JSON.stringify(payload);
    return this.requestRoute('POST', path, handle, body);
  }

  private kbReadByKind(kind: KbReadKind, slug: string, context?: InvocationContext): Promise<KbReadResult> {
    switch (kind) {
      case 'note':
        return this.kbReadNote(slug, context);
      case 'memo':
        return this.kbReadMemo(slug, this.resolveContext(context, 'kb memo read'));
      case 'source':
        return this.kbReadSource(slug, context);
      case 'community':
        return this.kbReadCommunity(slug, context);
      case 'principle':
        return this.kbReadPrinciple(slug, context);
    }
  }

  private kbReadNote(slug: string, context?: InvocationContext): Promise<KbReadResult> {
    return this.getRoute(`/kb/notes/${encodeURIComponent(slug)}`, context);
  }

  private kbReadMemo(slug: string, context: InvocationContext): Promise<KbReadResult> {
    return this.getRoute(
      this.buildRoutePath(`/kb/memos/${encodeURIComponent(slug)}`, {
        projectRoot: context.projectRoot,
      }),
      context,
    );
  }

  private kbReadSource(slug: string, context?: InvocationContext): Promise<KbReadResult> {
    return this.getRoute(`/kb/sources/${encodeURIComponent(slug)}`, context);
  }

  private kbReadCommunity(slug: string, context?: InvocationContext): Promise<KbReadResult> {
    return this.getRoute(`/kb/communities/${encodeURIComponent(slug)}`, context);
  }

  private kbReadPrinciple(slug: string, context?: InvocationContext): Promise<KbReadResult> {
    return this.getRoute(`/kb/principles/${encodeURIComponent(slug)}`, context);
  }

  private createWaitStream(body: ReadableStream<Uint8Array>): ReadableStream<WaitStreamEvent> {
    return new ReadableStream<WaitStreamEvent>({
      start(controller) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const enqueueParsedBlock = (block: string): void => {
          const parsed = parseSseBlock(block);
          if (!parsed) return;
          const event = parseWaitStreamEvent(parsed.event, parsed.data);
          if (!event) return;
          controller.enqueue(event);
        };

        const pump = async (): Promise<void> => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const blocks = buffer.split('\n\n');
              buffer = blocks.pop() ?? '';

              for (const block of blocks) {
                enqueueParsedBlock(block);
              }
            }

            buffer += decoder.decode();
            enqueueParsedBlock(buffer);
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        };

        void pump();
      },
      cancel(reason) {
        return body.cancel(reason);
      },
    });
  }
}
