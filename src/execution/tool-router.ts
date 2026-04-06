import type { SpawnCliFn } from './engine.js';
import type { ExecutionService } from './service.js';
import type { AbortResult } from './abort-registry.js';
import type { DiscussContext } from './discuss/context.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CurateHandle } from '../kb/curate.js';
import type { KbRuntime } from '../kb/contracts.js';
import type { CallerContext, ToolRequest } from './request-context.js';
import { handleKbToolCall } from './kb-tools.js';
import { handleDiscussToolCall } from './discuss-tools.js';
import {
  domainError,
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

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return fallback;
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
  _providerRegistry?: ProviderRegistry,
): Array<Record<string, unknown>> {
  return [
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
  _providerRegistry?: ProviderRegistry,
): Promise<ToolDomainResult> {
  try {
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

    return domainError('not_found', `Unknown tool: ${request.name}`);
  } catch (error: unknown) {
    return domainError('internal_error', errorMessage(error, 'Internal error'));
  }
}
