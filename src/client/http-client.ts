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
  KbSourceDeleteInput,
  KbSourcePersistInput,
  KbUpdateInput,
} from '../kb/types.js';
import { isRecord } from '../shared/utils.js';
import { describeHttpError, HEALTH_TIMEOUT_MS, parseJsonResponse, TOOL_TIMEOUT_MS } from '../shared/sse-parser.js';
import { isBackendHealth, type BackendHealth } from './backend-health.js';
import type { ToolDomainResult } from '../execution/tool-response.js';

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

interface ProviderAgentDispatchOptions {
  context?: CallerContext;
  session?: string;
  work_dir?: string;
  model?: string;
  owner?: string;
  bypass_permissions?: boolean;
}

interface WorkflowOptions {
  start_prompt: string;
  context?: string;
  provider?: string;
  work_dir?: string;
  owner?: string;
}

export { isBackendHealth };
export type { CallerContext, BackendHealth };

function isCallerContext(value: unknown): value is CallerContext {
  return (
    isRecord(value) &&
    typeof value.projectRoot === 'string' &&
    typeof value.pluginRoot === 'string' &&
    isRecord(value.coralEnv)
  );
}

function isBackendRecoveringResult(value: unknown): value is Extract<ToolDomainResult, { ok: false }> {
  return (
    isRecord(value) && value.ok === false && value.code === 'backend_recovering' && typeof value.message === 'string'
  );
}

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

  constructor(
    options: {
      ensureBackend?: (pluginRoot?: string) => Promise<BackendHandle>;
      defaultContext?: CallerContext;
    } = {},
  ) {
    this.defaultContext = options.defaultContext;
    const defaultPluginRoot = this.defaultContext?.pluginRoot;
    this.ensureBackendHandle =
      options.ensureBackend ?? ((pluginRoot?: string) => defaultEnsureBackend(pluginRoot ?? defaultPluginRoot));
  }

  async exec(prompt: string, options: ProviderToolOptions = {}): Promise<ToolDomainResult> {
    return this.providerExec('codex', prompt, options);
  }

  async resume(session: string, prompt: string, options: ProviderToolOptions = {}): Promise<ToolDomainResult> {
    const { context, ...args } = options;
    return this.postDedicatedToolRoute(
      '/provider/codex',
      { op: 'resume', session, prompt, ...args },
      this.resolveContext(context),
    );
  }

  async fork(source: string, prompt?: string, options: ProviderToolOptions = {}): Promise<ToolDomainResult> {
    return this.providerFork('codex', source, prompt, options);
  }

  async abort(jobId: string, context?: CallerContext): Promise<ToolDomainResult> {
    return this.abortJobs([jobId], context);
  }

  async workflow(expression: string, options: WorkflowOptions): Promise<ToolDomainResult>;
  async workflow(expression: string, context: CallerContext, options: WorkflowOptions): Promise<ToolDomainResult>;
  async workflow(
    expression: string,
    contextOrOptions: CallerContext | WorkflowOptions,
    maybeOptions?: WorkflowOptions,
  ): Promise<ToolDomainResult> {
    const callerContext = isCallerContext(contextOrOptions) ? contextOrOptions : undefined;
    const options = callerContext ? maybeOptions : contextOrOptions;

    if (!options) throw new Error('Workflow options are required');

    return this.postDedicatedToolRoute('/workflow', { expression, ...options }, this.resolveContext(callerContext));
  }

  async providerExec(provider: string, prompt: string, options: ProviderExecOptions = {}): Promise<ToolDomainResult> {
    const { context, ...args } = options;
    return this.postDedicatedToolRoute(
      `/provider/${encodeURIComponent(provider)}`,
      { op: 'exec', prompt, ...args },
      this.resolveContext(context),
    );
  }

  async providerFork(
    provider: string,
    session: string,
    prompt?: string,
    options: ProviderToolOptions = {},
  ): Promise<ToolDomainResult> {
    const { context, ...args } = options;
    const request: Record<string, unknown> = { op: 'fork', session, ...args };

    if (prompt !== undefined) {
      request.prompt = prompt;
    }

    return this.postDedicatedToolRoute(
      `/provider/${encodeURIComponent(provider)}`,
      request,
      this.resolveContext(context),
    );
  }

  async providerList(provider: string, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute(
      `/provider/${encodeURIComponent(provider)}`,
      { op: 'list' },
      this.resolveContext(context),
    );
  }

  async providerAgentDispatch(
    provider: string,
    op: string,
    prompt: string,
    options: ProviderAgentDispatchOptions = {},
  ): Promise<ToolDomainResult> {
    const { context, ...args } = options;
    return this.postDedicatedToolRoute(
      `/provider/${encodeURIComponent(provider)}`,
      { op, prompt, ...args },
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
  ): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/discuss/seed', args, this.resolveContext(context));
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
  ): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/discuss/start', args, this.resolveContext(context));
  }

  async discussWatch(session: string, cursor?: number, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/discuss/watch', { session, cursor }, this.resolveContext(context));
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
  ): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/discuss/participate', args, this.resolveContext(context));
  }

  async discussAbort(session: string, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/discuss/abort', { session }, this.resolveContext(context));
  }

  async abortJobs(jobIds: string[], context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/abort', { jobs: jobIds }, this.resolveContext(context));
  }

  async kbSearch(args: KbSearchInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/search', args, this.resolveContext(context));
  }

  async kbPrinciples(args: KbPrinciplesInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/principles', args, this.resolveContext(context));
  }

  async kbRead(args: KbReadInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/read', args, this.resolveContext(context));
  }

  async kbPromote(args: KbPromoteInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/promote', args, this.resolveContext(context));
  }

  async kbUpdate(args: KbUpdateInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/update', args, this.resolveContext(context));
  }

  async kbDelete(args: KbDeleteInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/delete', args, this.resolveContext(context));
  }

  async kbSourceImport(args: KbSourcePersistInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/source-import', args, this.resolveContext(context));
  }

  async kbSourceList(context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/source-list', {}, this.resolveContext(context));
  }

  async kbSourceDelete(args: KbSourceDeleteInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/source-delete', args, this.resolveContext(context));
  }

  async kbMemo(args: KbMemoInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/memo', args, this.resolveContext(context));
  }

  async kbMemoList(args: KbMemoListInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/memo-list', args, this.resolveContext(context));
  }

  async kbMemoDelete(args: KbMemoDeleteInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/memo-delete', args, this.resolveContext(context));
  }

  async kbMemoPurge(args: KbMemoPurgeInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/memo-purge', args, this.resolveContext(context));
  }

  async kbReindex(args: KbReindexInput, context?: CallerContext): Promise<ToolDomainResult> {
    return this.postDedicatedToolRoute('/kb/reindex', args, this.resolveContext(context));
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
    const pluginRoot = context?.pluginRoot ?? this.defaultContext?.pluginRoot;
    return this.ensureBackendHandle(pluginRoot);
  }

  private buildCallerContext(ctx: CallerContext): CallerContext {
    return {
      projectRoot: ctx.projectRoot,
      pluginRoot: ctx.pluginRoot,
      coralEnv: ctx.coralEnv,
    };
  }

  private async postDedicatedToolRoute(
    path: string,
    args: Record<string, unknown>,
    ctx: CallerContext,
  ): Promise<ToolDomainResult> {
    const { port, host, token } = await this.resolveBackendHandle(ctx);
    const body = JSON.stringify({
      context: this.buildCallerContext(ctx),
      args,
    });

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
          return responseBody as ToolDomainResult;
        }

        if (response.status === 503 && isBackendRecoveringResult(responseBody)) {
          return responseBody;
        }

        throw new BackendToolHttpError(
          describeHttpError(response.status, response.statusText),
          response.status,
          responseBody,
        );
      });
    } catch (error) {
      throwBackendCommunicationError(error);
    }
  }
}
