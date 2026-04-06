import { requireString } from './tool-response.js';
import type { SpawnCliFn } from './engine.js';
import {
  coralAgentOpSchema,
  internalProviderFieldsShape,
  sharedExecSchema,
  sharedForkSchema,
  sharedResumeSchema,
} from '../shared/schemas.js';
import type { ExecutionService } from './service.js';
import type { AbortResult } from './abort-registry.js';
import type { DiscussContext } from './discuss/context.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { CurateHandle } from '../kb/curate.js';
import type { KbRuntime } from '../kb/contracts.js';
import type { CallerContext, ToolRequest } from './request-context.js';
import { handleKbToolCall } from './kb-tools.js';
import { handleDiscussToolCall } from './discuss-tools.js';
import {
  domainError,
  domainSuccess,
  launchDecisionToDomain,
  type ToolDomainResult,
} from './tool-response.js';

export type ExecutionServiceLike = Pick<
  ExecutionService,
  'start' | 'resume' | 'fork' | 'coralDispatch' | 'executeWorkflow' | 'list' | 'abort' | 'waitStream' | 'waitStreamOnce'
>;

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
) => Promise<ToolDomainResult>;

export type KbSubsystem = {
  kb: KbRuntime;
  curateScheduler: CurateHandle;
};

export type CreateKbSubsystemFn = (options: {
  pluginRoot: string;
  spawnCli: SpawnCliFn;
}) => Promise<KbSubsystem>;

const CORAL_OP_PREFIX = 'coral:';

function toProviderFields(
  data: { session?: string; prompt?: string; work_dir?: string; model?: string; system_prompt?: string },
  bypassPermissions: boolean,
): {
  sessionId: string;
  prompt: string;
  cwd: string | undefined;
  model: string | undefined;
  bypassPermissions: boolean;
  systemPrompt: string | undefined;
} {
  return {
    sessionId: data.session ?? '',
    prompt: data.prompt ?? '',
    cwd: data.work_dir,
    model: data.model,
    bypassPermissions,
    systemPrompt: data.system_prompt,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return fallback;
}

function invalidRequest(message: string, detail?: unknown): ToolDomainResult {
  return domainError('invalid_request', message, detail);
}

function isCoralTargetError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith('Invalid coral target name:') ||
    error.message.startsWith('Coral content not found:') ||
    error.message === 'Invalid coral path'
  );
}

export function isWorkAdmittingToolRequest(request: ToolRequest): boolean {
  if (request.name === 'workflow') {
    return true;
  }

  const op = typeof request.args.op === 'string' ? request.args.op : null;
  if (op === null) {
    return false;
  }

  return op === 'exec' || op === 'resume' || op === 'fork' || op === 'bypass_exec' || op.startsWith(CORAL_OP_PREFIX);
}

/**
 * Build MCP tool descriptors for all registered providers plus built-in tools.
 * The default registry is a convenience for CLI/bridge callers that don't own a backend.
 * Backend paths should always pass their owned registry explicitly.
 */
export function getToolDescriptors(
  providerRegistry: ProviderRegistry = createBuiltInProviderRegistry(),
): Array<Record<string, unknown>> {
  const providerTools = providerRegistry.getAll().map((provider) => ({
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
      description:
        'Submit a bid (score + thought) or speech (content) for an active discussion participant. Provide either score+thought or content, not both.',
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
  providerRegistry: ProviderRegistry = createBuiltInProviderRegistry(),
): Promise<ToolDomainResult> {
  try {
    if (request.name === 'abort') {
      if (!isStringArray(request.args.jobs)) {
        return invalidRequest('jobs must be string array');
      }
      const scopeCheck = helpers.scopeCheckJobs(request.args.jobs, request.context.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch });
      }
      return domainSuccess(helpers.abortJobs(scopeCheck.valid));
    }

    if (request.name === 'wait') {
      return domainError('use_sse', 'Use POST /wait/stream for wait operations');
    }

    const discussResult = await handleDiscussToolCall(request, helpers);
    if (discussResult !== null) {
      return discussResult;
    }

    if (request.name.startsWith('kb_')) {
      if (!kbSubsystem) {
        return domainError('kb_unavailable', 'Knowledge base is not available. Check backend health for details.');
      }
      return handleKbToolCall(request, kbSubsystem);
    }

    if (!providerRegistry.get(request.name)) {
      return domainError('not_found', `Unknown tool: ${request.name}`);
    }

    const service = helpers.getExecutionService(request.context);
    const op = requireString(request.args, 'op');
    if (!op) {
      return invalidRequest('op is required');
    }

    const defaultCwd = request.context.projectRoot;

    if (op === 'list') {
      return domainSuccess(service.list(request.name));
    }

    if (op === 'fork') {
      const parsed = sharedForkSchema.extend(internalProviderFieldsShape).safeParse(request.args);
      if (!parsed.success) return invalidRequest(parsed.error.message);
      return launchDecisionToDomain(await service.fork(request.name, toProviderFields(parsed.data, true), request.context));
    }

    if (op === 'resume') {
      const parsed = sharedResumeSchema.extend(internalProviderFieldsShape).safeParse(request.args);
      if (!parsed.success) return invalidRequest(parsed.error.message);
      return launchDecisionToDomain(
        await service.resume(request.name, toProviderFields(parsed.data, true), request.context),
      );
    }

    if (op === 'exec' || op === 'bypass_exec') {
      const parsed = sharedExecSchema.extend(internalProviderFieldsShape).safeParse(request.args);
      if (!parsed.success) return invalidRequest(parsed.error.message);

      const bypassPermissions = op === 'bypass_exec';

      if (parsed.data.session) {
        return launchDecisionToDomain(
          await service.resume(request.name, toProviderFields(parsed.data, bypassPermissions), request.context),
        );
      }

      return launchDecisionToDomain(
        await service.start(
          request.name,
          {
            ...toProviderFields(parsed.data, bypassPermissions),
            cwd: parsed.data.work_dir ?? defaultCwd,
          },
          request.context,
        ),
      );
    }

    if (op.startsWith(CORAL_OP_PREFIX)) {
      const parsed = coralAgentOpSchema.safeParse(request.args);
      if (!parsed.success) {
        return invalidRequest(parsed.error.message);
      }

      const effectiveContext = parsed.data.owner
        ? { ...request.context, coralEnv: { ...request.context.coralEnv, CORAL_OWNER: parsed.data.owner } }
        : request.context;

      try {
        return launchDecisionToDomain(
          await service.coralDispatch(
            request.name,
            parsed.data.op.slice(CORAL_OP_PREFIX.length),
            {
              prompt: parsed.data.prompt,
              sessionId: parsed.data.session,
              cwd: parsed.data.session ? parsed.data.work_dir : (parsed.data.work_dir ?? defaultCwd),
            },
            effectiveContext,
          ),
        );
      } catch (error: unknown) {
        if (isCoralTargetError(error)) {
          return invalidRequest(error.message);
        }
        throw error;
      }
    }

    return invalidRequest(`Unsupported op: ${op}`);
  } catch (error: unknown) {
    return domainError('internal_error', errorMessage(error, 'Internal error'));
  }
}
