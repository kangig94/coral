import { ensureBackend as defaultEnsureBackend, withAbortTimeout, type BackendHandle } from './backend-lifecycle.js';
import type { CallerContext } from '../execution/request-context.js';
import type {
  KbMemoDeleteInput,
  KbDeleteInput,
  KbMemoInput,
  KbMemoListInput,
  KbMemoPurgeInput,
  KbPrinciplesInput,
  KbPromoteInput,
  KbReadInput,
  KbReindexInput,
  KbSearchInput,
  KbUpdateInput,
} from '../kb/types.js';
import { isRecord } from '../shared/mcp-utils.js';
import {
  describeHttpError,
  HEALTH_TIMEOUT_MS,
  parseJsonResponse,
  TOOL_TIMEOUT_MS,
} from '../shared/sse-parser.js';
import { isBackendHealth, type BackendHealth } from './backend-health.js';

interface ProviderToolOptions {
  context?: CallerContext;
  work_dir?: string;
  model?: string;
  bypass_permissions?: boolean;
  system_prompt?: string;
}

interface ProviderExecOptions extends ProviderToolOptions {
  session?: string;
}

interface ProviderCoralDispatchOptions {
  context?: CallerContext;
  session?: string;
  work_dir?: string;
}

interface WorkflowOptions {
  init_prompt: string;
  context?: string;
  provider?: string;
  work_dir?: string;
  stale_timeout_seconds?: number;
  atoms?: Record<string, { instruction?: string }>;
}

export { isBackendHealth };
export type { CallerContext, BackendHealth };

function isCallerContext(value: unknown): value is CallerContext {
  return isRecord(value)
    && typeof value.projectRoot === 'string'
    && typeof value.pluginRoot === 'string'
    && isRecord(value.coralEnv);
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

/**
 * Typed HTTP wrapper around the Coral backend endpoints used by coral-reef.
 */
export class BackendClient {
  private readonly ensureBackendHandle: (pluginRoot?: string) => Promise<BackendHandle>;
  private readonly defaultContext?: CallerContext;

  constructor(options: {
    ensureBackend?: (pluginRoot?: string) => Promise<BackendHandle>;
    defaultContext?: CallerContext;
  } = {}) {
    this.defaultContext = options.defaultContext;
    const defaultPluginRoot = this.defaultContext?.pluginRoot;
    this.ensureBackendHandle = options.ensureBackend
      ?? ((pluginRoot?: string) => defaultEnsureBackend(pluginRoot ?? defaultPluginRoot));
  }

  /**
   * Starts a new Codex execution.
   */
  async exec(prompt: string, options: ProviderToolOptions = {}): Promise<unknown> {
    return this.providerExec('codex', prompt, options);
  }

  /**
   * Resumes an existing Codex session.
   */
  async resume(session: string, prompt: string, options: ProviderToolOptions = {}): Promise<unknown> {
    const { context, ...args } = options;
    return this.proxyToolCall('codex', { op: 'resume', session, prompt, ...args }, this.resolveContext(context));
  }

  /**
   * Forks a Codex session, optionally with a follow-up prompt.
   */
  async fork(source: string, prompt?: string, options: ProviderToolOptions = {}): Promise<unknown> {
    return this.providerFork('codex', source, prompt, options);
  }

  /**
   * Aborts a single backend job.
   */
  async abort(jobId: string, context?: CallerContext): Promise<unknown> {
    return this.abortJobs([jobId], context);
  }

  /**
   * Executes a workflow expression through the backend workflow tool.
   */
  async workflow(expression: string, options: WorkflowOptions): Promise<unknown>;
  async workflow(expression: string, context: CallerContext, options: WorkflowOptions): Promise<unknown>;
  async workflow(
    expression: string,
    contextOrOptions: CallerContext | WorkflowOptions,
    maybeOptions?: WorkflowOptions,
  ): Promise<unknown> {
    const callerContext = isCallerContext(contextOrOptions) ? contextOrOptions : undefined;
    const options = callerContext ? maybeOptions : contextOrOptions;

    if (!options) throw new Error('Workflow options are required');

    return this.proxyToolCall('workflow', { expression, ...options }, this.resolveContext(callerContext));
  }

  async providerExec(provider: string, prompt: string, options: ProviderExecOptions = {}): Promise<unknown> {
    const { context, ...args } = options;
    return this.proxyToolCall(provider, { op: 'exec', prompt, ...args }, this.resolveContext(context));
  }

  async providerFork(
    provider: string,
    session: string,
    prompt?: string,
    options: ProviderToolOptions = {},
  ): Promise<unknown> {
    const { context, ...args } = options;
    const request: Record<string, unknown> = { op: 'fork', session, ...args };

    if (prompt !== undefined) {
      request.prompt = prompt;
    }

    return this.proxyToolCall(provider, request, this.resolveContext(context));
  }

  async providerList(provider: string, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall(provider, { op: 'list' }, this.resolveContext(context));
  }

  async providerCoralDispatch(
    provider: string,
    agentName: string,
    prompt: string,
    options: ProviderCoralDispatchOptions = {},
  ): Promise<unknown> {
    const { context, ...args } = options;
    return this.proxyToolCall(
      provider,
      { op: `coral:${agentName}`, prompt, ...args },
      this.resolveContext(context),
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
  ): Promise<unknown> {
    return this.proxyToolCall('discuss_seed', args, this.resolveContext(context));
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
  ): Promise<unknown> {
    return this.proxyToolCall('discuss_start', args, this.resolveContext(context));
  }

  async discussWatch(session: string, cursor?: number, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('discuss_watch', { session, cursor }, this.resolveContext(context));
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
  ): Promise<unknown> {
    return this.proxyToolCall('discuss_participate', args, this.resolveContext(context));
  }

  async discussAbort(session: string, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('discuss_abort', { session }, this.resolveContext(context));
  }

  async abortJobs(jobIds: string[], context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('abort', { jobs: jobIds }, this.resolveContext(context));
  }

  async kbSearch(args: KbSearchInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_search', args, this.resolveContext(context));
  }

  async kbPrinciples(args: KbPrinciplesInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_principles', args, this.resolveContext(context));
  }

  async kbRead(args: KbReadInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_read', args, this.resolveContext(context));
  }

  async kbPromote(args: KbPromoteInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_promote', args, this.resolveContext(context));
  }

  async kbUpdate(args: KbUpdateInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_update', args, this.resolveContext(context));
  }

  async kbDelete(args: KbDeleteInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_delete', args, this.resolveContext(context));
  }

  async kbMemo(args: KbMemoInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_memo', args, this.resolveContext(context));
  }

  async kbMemoList(args: KbMemoListInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_memo_list', args, this.resolveContext(context));
  }

  async kbMemoDelete(args: KbMemoDeleteInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_memo_delete', args, this.resolveContext(context));
  }

  async kbMemoPurge(args: KbMemoPurgeInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_memo_purge', args, this.resolveContext(context));
  }

  async kbReindex(args: KbReindexInput, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('kb_reindex', args, this.resolveContext(context));
  }

  /**
   * Returns backend health metadata when the daemon responds with a valid payload.
   */
  async health(): Promise<BackendHealth | null> {
    const { port, host, token } = await this.resolveBackendHandle();

    try {
      const response = await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) => fetch(`http://${host}:${port}/health`, {
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': token },
        signal,
      }));

      if (!response.ok) {
        return null;
      }

      const body = await parseJsonResponse(response);
      return isBackendHealth(body) ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Requests backend shutdown.
   */
  async shutdown(): Promise<{ ok: boolean }> {
    const { port, host, token } = await this.resolveBackendHandle();

    try {
      const response = await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) => fetch(`http://${host}:${port}/admin/shutdown`, {
        method: 'POST',
        headers: { 'X-Coral-Backend-Token': token },
        signal,
      }));

      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Lists the tool descriptors currently served by the backend.
   */
  async listTools(): Promise<unknown> {
    const { port, host, token } = await this.resolveBackendHandle();

    try {
      return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
        const response = await fetch(`http://${host}:${port}/tools`, {
          method: 'GET',
          headers: { 'X-Coral-Backend-Token': token },
          signal,
        });

        if (!response.ok) {
          throw new Error(describeHttpError(response.status, response.statusText));
        }

        return parseJsonResponse(response);
      });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Backend communication error: ${String(error)}`);
    }
  }

  private resolveContext(context?: CallerContext): CallerContext {
    const resolvedContext = context ?? this.defaultContext;
    if (resolvedContext) return resolvedContext;
    throw new Error('CallerContext is required for backend tool calls');
  }

  private resolveBackendHandle(context?: CallerContext): Promise<BackendHandle> {
    const pluginRoot = context?.pluginRoot ?? this.defaultContext?.pluginRoot;
    return this.ensureBackendHandle(pluginRoot);
  }

  private async proxyToolCall(
    name: string,
    args: Record<string, unknown>,
    ctx: CallerContext,
  ): Promise<unknown> {
    const { port, host, token } = await this.resolveBackendHandle(ctx);
    const body = JSON.stringify({
      name,
      args,
      context: {
        projectRoot: ctx.projectRoot,
        pluginRoot: ctx.pluginRoot,
        coralEnv: ctx.coralEnv,
      },
    });

    try {
      return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
        const response = await fetch(`http://${host}:${port}/tool`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': token,
          },
          body,
          signal,
        });

        const responseBody = await parseJsonResponse(response);

        if (!response.ok) {
          throw new BackendToolHttpError(
            describeHttpError(response.status, response.statusText),
            response.status,
            responseBody,
          );
        }

        return responseBody;
      });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Backend communication error: ${String(error)}`);
    }
  }
}
