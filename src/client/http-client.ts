import { ensureBackend as defaultEnsureBackend, withAbortTimeout, type BackendHandle } from './backend-lifecycle.js';
import type { BackendHealth } from './backend-health.js';
import { isBackendHealth } from './backend-health.js';
import type { AbortResult } from '../execution/abort-registry.js';
import type { CallerContext } from '../execution/request-context.js';
import type { BidResult, PersonaSeedOutput, SpeechResult } from '../discuss/types.js';
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
} from '../kb/types.js';
import type { EffortLevel } from '../shared/schemas.js';
import type { LenientSessionEntry } from '../shared/session-entry.js';
import {
  describeHttpError,
  HEALTH_TIMEOUT_MS,
  parseJsonResponse,
  parseSseBlock,
  parseWaitStreamEvent,
  TOOL_TIMEOUT_MS,
} from '../shared/sse-parser.js';
import type { PersistedProgressRecord, PersistedStatusRecord, WaitCursor, WaitStreamEvent } from '../shared/types.js';
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

export type SessionsListResponse = {
  sessions: LenientSessionEntry[];
};

export type JobsListResponse = {
  jobs: Array<{ jobId: string; status: PersistedStatusRecord }>;
};

export type JobDetailResponse = {
  status: PersistedStatusRecord;
  events: PersistedProgressRecord[];
};

export type DiscussStartResponse = {
  session: string;
};

export type DiscussAbortResponse = {
  ok: true;
  session: string;
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
export type { CallerContext, BackendHealth };

function throwBackendCommunicationError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error(`Backend communication error: ${String(error)}`, { cause: error });
}

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

  async listSessions(): Promise<SessionsListResponse> {
    return this.getRoute('/sessions');
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

  async listJobs(phase?: string): Promise<JobsListResponse> {
    const query = phase ? `?phase=${encodeURIComponent(phase)}` : '';
    return this.getRoute(`/api/jobs${query}`);
  }

  async getJob(jobId: string): Promise<JobDetailResponse> {
    return this.getRoute(`/api/jobs/${encodeURIComponent(jobId)}`);
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
    return this.postRoute('/discuss/seed', args, this.resolveContext(context));
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
    return this.postRoute('/discuss/start', args, this.resolveContext(context));
  }

  async discussWatch(session: string, cursor?: number, context?: CallerContext): Promise<WatchState> {
    return this.postRoute('/discuss/watch', { session, cursor }, this.resolveContext(context));
  }

  async discussParticipate(
    args: {
      session: string;
      agent_name: string;
      score?: number;
      thought?: string;
      content?: string;
    },
    context?: CallerContext,
  ): Promise<BidResult | SpeechResult> {
    return this.postRoute('/discuss/participate', args, this.resolveContext(context));
  }

  async discussAbort(session: string, context?: CallerContext): Promise<DiscussAbortResponse> {
    return this.postRoute('/discuss/abort', { session }, this.resolveContext(context));
  }

  async kbSearch(args: KbSearchInput, context?: CallerContext): Promise<KbSearchResponse> {
    return this.postRoute('/kb/search', args, this.resolveContext(context));
  }

  async kbPrinciples(args: KbPrinciplesInput, context?: CallerContext): Promise<KbPrinciplesResult> {
    return this.postRoute('/kb/principles', args, this.resolveContext(context));
  }

  async kbRead(args: KbReadInput, context?: CallerContext): Promise<KbReadResult> {
    return this.postRoute('/kb/read', args, this.resolveContext(context));
  }

  async kbPromote(args: KbPromoteInput, context?: CallerContext): Promise<KbPromoteResponse> {
    return this.postRoute('/kb/promote', args, this.resolveContext(context));
  }

  async kbUpdate(args: KbUpdateInput, context?: CallerContext): Promise<KbUpdateResponse> {
    return this.postRoute('/kb/update', args, this.resolveContext(context));
  }

  async kbDelete(args: KbDeleteInput, context?: CallerContext): Promise<KbDeleteResponse> {
    return this.postRoute('/kb/delete', args, this.resolveContext(context));
  }

  async kbSourceImport(args: KbSourcePersistInput, context?: CallerContext): Promise<KbSourceImportResponse> {
    return this.postRoute('/kb/source-import', args, this.resolveContext(context));
  }

  async kbSourceList(context?: CallerContext): Promise<KbSourceListResult> {
    return this.postRoute('/kb/source-list', {}, this.resolveContext(context));
  }

  async kbSourceDelete(args: KbSourceDeleteInput, context?: CallerContext): Promise<KbSourceDeleteResponse> {
    return this.postRoute('/kb/source-delete', args, this.resolveContext(context));
  }

  async kbMemo(args: KbMemoInput, context?: CallerContext): Promise<KbMemoResponse> {
    return this.postRoute('/kb/memo', args, this.resolveContext(context));
  }

  async kbMemoList(args: KbMemoListInput, context?: CallerContext): Promise<KbMemoListResult> {
    return this.postRoute('/kb/memo-list', args, this.resolveContext(context));
  }

  async kbMemoDelete(args: KbMemoDeleteInput, context?: CallerContext): Promise<KbMemoDeleteResult> {
    return this.postRoute('/kb/memo-delete', args, this.resolveContext(context));
  }

  async kbMemoPurge(args: KbMemoPurgeInput, context?: CallerContext): Promise<KbMemoPurgeResult> {
    return this.postRoute('/kb/memo-purge', args, this.resolveContext(context));
  }

  async kbReindex(args: KbReindexInput, context?: CallerContext): Promise<ReindexResult> {
    return this.postRoute('/kb/reindex', args, this.resolveContext(context));
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

  private resolveContext(context?: CallerContext): CallerContext {
    const resolvedContext = context ?? this.defaultContext;
    if (resolvedContext) return resolvedContext;
    throw new Error('CallerContext is required for backend tool calls');
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

  private describeError(response: Response, responseBody: unknown): string {
    if (isRecord(responseBody) && typeof responseBody.message === 'string' && responseBody.message.length > 0) {
      return responseBody.message;
    }

    return describeHttpError(response.status, response.statusText);
  }

  private async getRoute<T>(path: string): Promise<T> {
    const { port, host, token } = await this.resolveBackendHandle();

    try {
      return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
        const response = await fetch(`http://${host}:${port}${path}`, {
          method: 'GET',
          headers: {
            'X-Coral-Backend-Token': token,
          },
          signal,
        });
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

  private async postRoute<T>(path: string, args: Record<string, unknown>, ctx: CallerContext): Promise<T> {
    const { port, host, token } = await this.resolveBackendHandle(ctx);
    const body = JSON.stringify(this.buildRequestBody(args, ctx));

    try {
      return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
        const response = await fetch(`http://${host}:${port}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': token,
          },
          body,
          signal,
        });
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
          if (event) {
            controller.enqueue(event);
          }
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
