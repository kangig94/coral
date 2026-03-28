import { z } from 'zod';
import {
  assertOwnerId,
  textResult,
  type McpResult,
} from '../shared/mcp-utils.js';
import { internalProviderFieldsShape, sharedExecSchema, sharedForkSchema, sharedResumeSchema } from '../shared/schemas.js';
import type { ExecutionService } from './service.js';
import type { AbortResult } from './abort-registry.js';
import type { DiscussContext } from './discuss/context.js';
import { getAllNewProviders, getNewProvider } from '../providers/registry.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { handleWorkflow } from '../workflow/handler.js';
import type { CurateHandle } from '../kb/curate.js';
import type { KbRuntime } from '../kb/runtime.js';
import type { CallerContext, ToolRequest } from './request-context.js';
import { handleKbToolCall } from './kb-tools.js';
import { handleDiscussToolCall } from './discuss-tools.js';

export type ExecutionServiceLike = Pick<
  ExecutionService,
  'start' | 'resume' | 'fork' | 'coralDispatch' | 'executeWorkflow' | 'list' | 'abort' | 'waitStream' | 'waitStreamOnce'
>;

export type ToolRouteResponse = {
  statusCode: number;
  body: unknown;
};

export type ScopeCheckResult = {
  valid: string[];
  missing: string[];
  mismatch: string[];
};

export type RouteToolCallFn = (
  request: ToolRequest,
  helpers: {
    getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
    getDiscussContext: (ctx: CallerContext) => DiscussContext;
    abortJobs: (jobIds: string[]) => AbortResult;
    scopeCheckJobs: (jobIds: string[], projectRoot: string) => ScopeCheckResult;
  },
  kbSubsystem: KbSubsystem | null,
) => Promise<ToolRouteResponse>;

export type KbSubsystem = {
  kb: KbRuntime;
  curateScheduler: CurateHandle;
};

export type CreateKbSubsystemFn = (options: {
  pluginRoot: string;
  spawnCli: typeof import('./engine.js').spawnCli;
}) => Promise<KbSubsystem>;

const CORAL_OP_PREFIX = 'coral:';

function jsonTextResult(data: unknown, isError = false): McpResult {
  return textResult(JSON.stringify(data), isError);
}

function toProviderFields(
  data: { session?: string; prompt?: string; work_dir?: string; model?: string; system_prompt?: string },
  bypassPermissions: boolean,
): { sessionId: string; prompt: string; cwd: string | undefined; model: string | undefined; bypassPermissions: boolean; systemPrompt: string | undefined } {
  return {
    sessionId: data.session ?? '',
    prompt: data.prompt ?? '',
    cwd: data.work_dir,
    model: data.model,
    bypassPermissions,
    systemPrompt: data.system_prompt,
  };
}

function toolValidationError(error: z.ZodError): ToolRouteResponse {
  return {
    statusCode: 200,
    body: jsonTextResult({
      error: 'invalid_request',
      message: error.message,
    }, true),
  };
}

function toolError(error: string, detail?: Record<string, unknown>): ToolRouteResponse {
  return {
    statusCode: 200,
    body: jsonTextResult({
      error,
      ...(detail === undefined ? {} : detail),
    }, true),
  };
}

function toolSuccess(data: unknown): ToolRouteResponse {
  return {
    statusCode: 200,
    body: jsonTextResult(data),
  };
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function parseOptionalOwner(args: Record<string, unknown>, key: string): string | undefined {
  const raw = optionalString(args, key);
  if (raw === undefined) return undefined;
  return assertOwnerId(raw, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

export function getToolDescriptors(): Array<Record<string, unknown>> {
  registerBuiltInProviders();

  const providerTools = getAllNewProviders().map((provider) => ({
    name: provider.name,
    description: `Execute prompts with the ${provider.name} provider.`,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string' },
        prompt: { type: 'string' },
        session: { type: 'string' },
        work_dir: { type: 'string' },
        owner: { type: 'string' },
      },
      required: ['op'],
    },
  }));

  return [
    ...providerTools,
    {
      name: 'discuss_seed',
      description: 'Generate seeded discussion personas from controversy axes.',
      inputSchema: {
        type: 'object',
        properties: {
          controversy_axes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                axis: { type: 'string' },
                positions: { type: 'array', items: { type: 'string' } },
              },
              required: ['axis', 'positions'],
            },
          },
          n: { type: 'integer', minimum: 1, maximum: 20 },
          demographics: {
            type: 'object',
            properties: {
              origin_weights: {
                type: 'object',
                additionalProperties: { type: 'number' },
              },
              outlier_ratio: { type: 'number' },
            },
            required: ['origin_weights'],
          },
          seed: { type: 'integer' },
        },
        required: ['controversy_axes', 'n', 'seed'],
      },
    },
    {
      name: 'discuss_start',
      description: 'Start a backend-managed discussion session.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', minLength: 1 },
          agents: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                persona: { type: 'string' },
                participation: { type: 'string', enum: ['required', 'observer'] },
                provider: { type: 'string' },
                model: { type: 'string' },
              },
              required: ['name', 'persona'],
            },
          },
          config: {
            type: 'object',
            properties: {
              min_bid_delay_ms: { type: 'integer', minimum: 0 },
            },
          },
        },
        required: ['topic', 'agents'],
      },
    },
    {
      name: 'discuss_abort',
      description: 'Abort a live discussion session.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
        },
        required: ['session'],
      },
    },
    {
      name: 'discuss_watch',
      description: 'Poll the current watch-log snapshot for a discussion session.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          cursor: { type: 'integer', minimum: 0, description: 'Resume from this offset. Omit for full history.' },
        },
        required: ['session'],
      },
    },
    {
      name: 'discuss_participate',
      description: 'Submit a bid (score + thought) or speech (content) for an active discussion participant. Provide either score+thought or content, not both.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          agent_name: { type: 'string' },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          thought: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['session', 'agent_name'],
      },
    },
    {
      name: 'wait',
      description: 'Stream job progress and completion events over POST /wait/stream.',
      inputSchema: {
        type: 'object',
        properties: {
          jobIds: { type: 'array', items: { type: 'string' } },
          timeoutSeconds: { type: 'number' },
          cursor: { type: 'object' },
        },
        required: ['jobIds'],
      },
    },
    {
      name: 'abort',
      description: 'Abort running jobs by job ID.',
      inputSchema: {
        type: 'object',
        properties: {
          jobs: { type: 'array', items: { type: 'string' } },
        },
        required: ['jobs'],
      },
    },
    {
      name: 'workflow',
      description: 'Execute a workflow pipeline across one or more Coral atoms.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Pipeline DSL expression' },
          init_prompt: { type: 'string', description: 'Initial prompt fed to the first step' },
          context: { type: 'string', description: 'Shared context prepended to every atom prompt in every step' },
          provider: { type: 'string', description: 'Default provider for atoms (claude or codex)' },
          work_dir: { type: 'string', description: 'Working directory for spawned atoms' },
          owner: { type: 'string', description: 'Session owner ID for memo isolation' },
        },
        required: ['expression', 'init_prompt'],
      },
    },
  ];
}

export async function routeToolCall(
  request: ToolRequest,
  helpers: {
    getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
    getDiscussContext: (ctx: CallerContext) => DiscussContext;
    abortJobs: (jobIds: string[]) => AbortResult;
    scopeCheckJobs: (jobIds: string[], projectRoot: string) => ScopeCheckResult;
  },
  kbSubsystem: KbSubsystem | null = null,
): Promise<ToolRouteResponse> {
  registerBuiltInProviders();

  if (request.name === 'abort') {
    if (!isStringArray(request.args.jobs)) {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    const scopeCheck = helpers.scopeCheckJobs(request.args.jobs, request.context.projectRoot);
    if (scopeCheck.mismatch.length > 0) {
      return { statusCode: 403, body: { error: 'scope_mismatch', jobs: scopeCheck.mismatch } };
    }
    return { statusCode: 200, body: helpers.abortJobs(scopeCheck.valid) };
  }

  if (request.name === 'wait') {
    return {
      statusCode: 400,
      body: { error: 'use_sse', message: 'Use POST /wait/stream for wait operations' },
    };
  }

  if (request.name === 'workflow') {
    const svc = helpers.getExecutionService(request.context);
    const decision = await handleWorkflow(request.args, svc, request.context);
    return { statusCode: 200, body: decision };
  }

  const discussResult = await handleDiscussToolCall(request, helpers);
  if (discussResult !== null) {
    return discussResult;
  }

  if (request.name.startsWith('kb_') && kbSubsystem) {
    return handleKbToolCall(request, kbSubsystem);
  }

  if (!getNewProvider(request.name)) {
    return {
      statusCode: 404,
      body: { error: 'not_found', message: `Unknown tool: ${request.name}` },
    };
  }

  const service = helpers.getExecutionService(request.context);
  const op = requireString(request.args, 'op');
  if (!op) {
    return { statusCode: 400, body: { error: 'invalid_request' } };
  }

  const sessionId = optionalString(request.args, 'session');
  const prompt = optionalString(request.args, 'prompt');
  const defaultCwd = request.context.projectRoot;
  const cwd = optionalString(request.args, 'work_dir');

  if (op === 'list') {
    return { statusCode: 200, body: service.list(request.name) };
  }

  if (op === 'fork') {
    const parsed = sharedForkSchema.extend(internalProviderFieldsShape).safeParse(request.args);
    if (!parsed.success) return { statusCode: 400, body: { error: 'invalid_request' } };
    return {
      statusCode: 200,
      body: await service.fork(request.name, toProviderFields(parsed.data, true), request.context),
    };
  }

  if (op === 'resume') {
    const parsed = sharedResumeSchema.extend(internalProviderFieldsShape).safeParse(request.args);
    if (!parsed.success) return { statusCode: 400, body: { error: 'invalid_request' } };
    return {
      statusCode: 200,
      body: await service.resume(request.name, toProviderFields(parsed.data, true), request.context),
    };
  }

  if (op === 'exec' || op === 'bypass_exec') {
    const parsed = sharedExecSchema.extend(internalProviderFieldsShape).safeParse(request.args);
    if (!parsed.success) return { statusCode: 400, body: { error: 'invalid_request' } };

    const bypassPermissions = op === 'bypass_exec';

    if (parsed.data.session) {
      return {
        statusCode: 200,
        body: await service.resume(request.name, toProviderFields(parsed.data, bypassPermissions), request.context),
      };
    }

    return {
      statusCode: 200,
      body: await service.start(request.name, {
        ...toProviderFields(parsed.data, bypassPermissions),
        cwd: parsed.data.work_dir ?? defaultCwd,
      }, request.context),
    };
  }

  if (op.startsWith(CORAL_OP_PREFIX)) {
    if (typeof prompt !== 'string') {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    const owner = parseOptionalOwner(request.args, 'owner');
    const effectiveContext = owner
      ? { ...request.context, coralEnv: { ...request.context.coralEnv, CORAL_OWNER: owner } }
      : request.context;
    return {
      statusCode: 200,
      body: await service.coralDispatch(request.name, op.slice(CORAL_OP_PREFIX.length), {
        prompt,
        sessionId,
        cwd: sessionId ? cwd : cwd ?? defaultCwd,
      }, effectiveContext),
    };
  }

  return { statusCode: 400, body: { error: 'invalid_request' } };
}
