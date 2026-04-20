import { resolveDiscoveredBackend as defaultEnsureBackend, withAbortTimeout, type BackendHandle } from './backend-handle.js';
import type { BackendHealth } from './backend-health.js';
import { isBackendHealth } from './backend-health.js';
import { throwBackendCommunicationError } from './backend-helpers.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import type { CallerContext } from '../shared/request-context.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '../discuss/session-types.js';
import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../discuss/views.js';
import type { WatchState } from '../discuss/watch.js';
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
} from '../kb/entry-types.js';
import type { EffortLevel } from '../shared/schemas.js';
import {
  KB_BARE_READ_ORDER,
  isKbMemoCandidateSlug,
  parseKbSelector,
  type KbReadKind,
} from '../shared/kb-read-contract.js';
import {
  describeHttpError,
  HEALTH_TIMEOUT_MS,
  parseJsonResponse,
  parseSseBlock,
  parseWaitStreamEvent,
  TOOL_TIMEOUT_MS,
} from '../shared/sse-parser.js';
import type { JobProgress, JobStatus } from '../jobs/views.js';
import type { WaitCursor, WaitStreamEvent } from '../jobs/wait.js';
import { isRecord } from '../shared/utils.js';

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
  slug: string;
  path: string;
};

export type KbSourceDeleteResponse = {
  deleted: string;
};

type SessionRequestOptions = {
  context?: CallerContext;
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
  context?: CallerContext;
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

export { isBackendHealth };
export type { BackendHealth };
export type { CallerContext } from '../shared/request-context.js';

export class BackendToolHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'BackendToolHttpError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BackendClient {
  private readonly ensureBackendHandle: (pluginRoot?: string) => Promise<BackendHandle>;
  private readonly defaultContext?: CallerContext;
  private readonly defaultPluginRoot?: string;

  constructor(
    options: {
      ensureBackend?: (pluginRoot?: string) => Promise<BackendHandle>;
      defaultContext?: CallerContext;
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
      options.ensureBackend ?? ((pluginRoot?: string) => defaultEnsureBackend(pluginRoot ?? this.defaultPluginRoot));
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
          'X-Coral-Backend-Token': token,
        },
        body,
      });
      const responseBody = response.ok ? undefined : await parseJsonResponse(response);

      if (!response.ok) {
        throw new BackendToolHttpError(this.describeError(response, responseBody), response.status, responseBody);
      }

      if (!response.body) {
        throw new Error('Backend wait stream returned no response body');
      }

      return this.createWaitStream(response.body);
    } catch (error) {
      throwBackendCommunicationError(error);
    }
  }

  async abortJobs(jobIds: string[], context?: CallerContext): Promise<AbortResult> {
    return this.postRoute('/jobs/abort', { jobs: jobIds }, this.resolveContext(context));
  }

  async listJobs(options: ListJobsOptions = {}, context?: CallerContext): Promise<JobsListResponse> {
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
    context: CallerContext,
    options: WorkflowOptions,
  ): Promise<WorkflowLaunchResponse>;
  async workflow(
    expression: string,
    contextOrOptions: CallerContext | WorkflowOptions,
    maybeOptions?: WorkflowOptions,
  ): Promise<WorkflowLaunchResponse> {
    const callerContext = maybeOptions === undefined ? undefined : (contextOrOptions as CallerContext);
    const options = maybeOptions ?? (contextOrOptions as WorkflowOptions);

    return this.postRoute(
      '/workflow',
      {
        expression,
        ...options,
      },
      this.resolveContext(callerContext),
    );
  }

  async discussSeed(
    args: {
      controversy_axes: Array<{ axis: string; positions: string[] }>;
      n: number;
      seed: number;
      demographics?: { origin_weights: Record<string, number>; outlier_ratio?: number };
    },
    context?: CallerContext,
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
    context?: CallerContext,
  ): Promise<DiscussStartResponse> {
    return this.postRoute('/discuss/sessions', args, this.resolveContext(context, 'discuss session creation'));
  }

  async discussWatch(session: string, context?: CallerContext): Promise<WatchState>;
  async discussWatch(session: string, cursor?: number, context?: CallerContext): Promise<WatchState>;
  async discussWatch(
    session: string,
    cursorOrContext?: number | CallerContext,
    maybeContext?: CallerContext,
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
    context?: CallerContext,
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
    context?: CallerContext,
  ): Promise<SpeechResult> {
    const { session, ...body } = args;
    return this.postRoute(
      `/discuss/sessions/${encodeURIComponent(session)}/speeches`,
      body,
      this.resolveContext(context, 'discuss speech'),
    );
  }

  async discussAbort(session: string, context?: CallerContext): Promise<DiscussAbortResponse> {
    const ctx = this.resolveContext(context, 'discuss abort');
    return this.deleteRoute(
      this.buildRoutePath(`/discuss/sessions/${encodeURIComponent(session)}`, {
        projectRoot: ctx.projectRoot,
      }),
      ctx,
    );
  }

  async listDiscussSessions(context?: CallerContext): Promise<DiscussSessionsListResponse> {
    return this.getRoute('/discuss/sessions', context);
  }

  async getDiscussSession(id: string, context?: CallerContext): Promise<DiscussDetailResponse>;
  async getDiscussSession(
    id: string,
    view?: DiscussView,
    context?: CallerContext,
  ): Promise<DiscussDetailResponse>;
  async getDiscussSession(
    id: string,
    viewOrContext?: DiscussView | CallerContext,
    maybeContext?: CallerContext,
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

  async kbSearch(args: KbSearchInput, context?: CallerContext): Promise<KbSearchResponse> {
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

  async kbPrinciples(args: KbPrinciplesInput, context?: CallerContext): Promise<KbPrinciplesResult> {
    return this.getRoute(
      this.buildRoutePath('/kb/principles', {
        q: args.query,
        top_k: args.top_k,
        verbose: args.verbose,
      }),
      context,
    );
  }

  async kbRead(args: KbReadInput, context?: CallerContext): Promise<KbReadResult> {
    const selector = parseKbSelector(args.note);
    if (selector.kind !== null) {
      return this.kbReadByKind(selector.kind, selector.slug, context);
    }

    const ctx = this.resolveContext(context, 'bare KB reads');
    let lastNotFound: BackendToolHttpError | null = null;

    for (const kind of KB_BARE_READ_ORDER) {
      if (kind === 'memo' && !isKbMemoCandidateSlug(selector.slug)) {
        continue;
      }

      try {
        return await this.kbReadByKind(kind, selector.slug, ctx);
      } catch (error) {
        if (error instanceof BackendToolHttpError && error.statusCode === 404) {
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

  async kbPromote(args: KbPromoteInput, context?: CallerContext): Promise<KbPromoteResponse> {
    return this.postRoute('/kb/notes', args, this.resolveContext(context, 'kb note creation'));
  }

  async kbUpdate(args: KbUpdateInput, context?: CallerContext): Promise<KbUpdateResponse> {
    const { note, ...body } = args;
    return this.putRoute(
      `/kb/notes/${encodeURIComponent(note)}`,
      body,
      this.resolveContext(context, 'kb note update'),
    );
  }

  async kbDelete(args: KbDeleteInput, context?: CallerContext): Promise<KbDeleteResponse> {
    return this.deleteRoute(`/kb/notes/${encodeURIComponent(args.note)}`, context);
  }

  async kbSourceImport(args: KbSourcePersistInput, context?: CallerContext): Promise<KbSourceImportResponse> {
    return this.postRoute('/kb/sources', args, this.resolveContext(context, 'kb source import'));
  }

  async kbSourceList(context?: CallerContext): Promise<KbSourceListResult> {
    return this.getRoute('/kb/sources', context);
  }

  async kbSourceDelete(args: KbSourceDeleteInput, context?: CallerContext): Promise<KbSourceDeleteResponse> {
    return this.deleteRoute(`/kb/sources/${encodeURIComponent(args.slug)}`, context);
  }

  async kbMemo(args: KbMemoInput, context?: CallerContext): Promise<KbMemoResponse> {
    return this.postRoute('/kb/memos', args, this.resolveContext(context, 'kb memo creation'));
  }

  async kbMemoList(args: KbMemoListInput, context?: CallerContext): Promise<KbMemoListResult> {
    const ctx = this.resolveContext(context, 'kb memo list');
    return this.getRoute(
      this.buildRoutePath('/kb/memos', {
        projectRoot: ctx.projectRoot,
        owner: this.resolveMemoOwner(args.owner, ctx),
      }),
      ctx,
    );
  }

  async kbMemoDelete(args: KbMemoDeleteInput, context?: CallerContext): Promise<KbMemoDeleteResult> {
    const ctx = this.resolveContext(context, 'kb memo delete');
    return this.deleteRoute(
      this.buildRoutePath('/kb/memos', {
        projectRoot: ctx.projectRoot,
        pattern: args.pattern,
        owner: this.resolveMemoOwner(args.owner, ctx),
      }),
      ctx,
    );
  }

  async kbMemoPurge(args: KbMemoPurgeInput, context?: CallerContext): Promise<KbMemoPurgeResult> {
    const ctx = this.resolveContext(context, 'kb memo purge');
    return this.deleteRoute(
      this.buildRoutePath('/kb/memos', {
        projectRoot: ctx.projectRoot,
        all: true,
        owner: this.resolveMemoOwner(args.owner, ctx),
      }),
      ctx,
    );
  }

  async kbReindex(args: KbReindexInput = {}, context?: CallerContext): Promise<ReindexResult> {
    void args;
    return this.postRoute('/kb/index', {}, this.resolveContext(context, 'kb reindex'));
  }

  async health(): Promise<BackendHealth | null> {
    const { port, host, token } = await this.resolveBackendHandle();

    try {
      const response = await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) =>
        fetch(`http://${host}:${port}/health`, {
          method: 'GET',
          headers: { 'X-Coral-Backend-Token': token },
          signal,
        }),
      );

      if (!response.ok) {
        return null;
      }

      const body = await parseJsonResponse(response);
      return isBackendHealth(body) ? body : null;
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
          headers: { 'X-Coral-Backend-Token': token },
          signal,
        }),
      );

      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }

  private resolveContext(context?: CallerContext, operation = 'backend tool calls'): CallerContext {
    const resolvedContext = context ?? this.defaultContext;
    if (resolvedContext) return resolvedContext;
    throw new Error(`CallerContext is required for ${operation}`);
  }

  private resolveBackendHandle(context?: CallerContext): Promise<BackendHandle> {
    const pluginRoot = context?.pluginRoot ?? this.defaultPluginRoot;
    return this.ensureBackendHandle(pluginRoot);
  }

  private buildRequestBody(args: Record<string, unknown>, ctx: CallerContext): Record<string, unknown> {
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

  private resolveMemoOwner(owner: string | undefined, ctx: CallerContext): string | undefined {
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
    handle: BackendHandle,
    body?: string,
  ): Promise<T> {
    const { port, host, token } = handle;
    const headers: Record<string, string> = {
      'X-Coral-Backend-Token': token,
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

        throw new BackendToolHttpError(this.describeError(response, responseBody), response.status, responseBody);
      });
    } catch (error) {
      throwBackendCommunicationError(error);
    }
  }

  private async getRoute<T>(path: string, context?: CallerContext): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    return this.requestRoute('GET', path, handle);
  }

  private async putRoute<T>(
    path: string,
    args: Record<string, unknown>,
    context?: CallerContext,
    options: { injectContext?: boolean } = {},
  ): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    const payload = context && options.injectContext !== false ? this.buildRequestBody(args, context) : args;
    const body = JSON.stringify(payload);
    return this.requestRoute('PUT', path, handle, body);
  }

  private async deleteRoute<T>(path: string, context?: CallerContext): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    return this.requestRoute('DELETE', path, handle);
  }

  private async postRoute<T>(
    path: string,
    args: Record<string, unknown>,
    context?: CallerContext,
    options: { injectContext?: boolean } = {},
  ): Promise<T> {
    const handle = await this.resolveBackendHandle(context);
    const payload = context && options.injectContext !== false ? this.buildRequestBody(args, context) : args;
    const body = JSON.stringify(payload);
    return this.requestRoute('POST', path, handle, body);
  }

  private kbReadByKind(kind: KbReadKind, slug: string, context?: CallerContext): Promise<KbReadResult> {
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

  private kbReadNote(slug: string, context?: CallerContext): Promise<KbReadResult> {
    return this.getRoute(`/kb/notes/${encodeURIComponent(slug)}`, context);
  }

  private kbReadMemo(slug: string, context: CallerContext): Promise<KbReadResult> {
    return this.getRoute(
      this.buildRoutePath(`/kb/memos/${encodeURIComponent(slug)}`, {
        projectRoot: context.projectRoot,
      }),
      context,
    );
  }

  private kbReadSource(slug: string, context?: CallerContext): Promise<KbReadResult> {
    return this.getRoute(`/kb/sources/${encodeURIComponent(slug)}`, context);
  }

  private kbReadCommunity(slug: string, context?: CallerContext): Promise<KbReadResult> {
    return this.getRoute(`/kb/communities/${encodeURIComponent(slug)}`, context);
  }

  private kbReadPrinciple(slug: string, context?: CallerContext): Promise<KbReadResult> {
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
