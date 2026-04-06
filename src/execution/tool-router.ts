import type { SpawnCliFn } from './engine.js';
import type { DiscussContext } from './discuss/context.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CurateHandle } from '../kb/curate.js';
import type { KbRuntime } from '../kb/contracts.js';
import type { CallerContext, ToolRequest } from './request-context.js';
export type { ExecutionServiceLike } from './backend-contracts.js';
import { handleKbToolCall } from './kb-tools.js';
import { handleDiscussToolCall } from './discuss-tools.js';
import {
  domainError,
  type ToolDomainResult,
} from './tool-response.js';

export type RouteToolCallHelpers = {
  getDiscussContext: (ctx: CallerContext) => DiscussContext;
  [key: string]: unknown;
};

export type RouteToolCallFn = (
  request: ToolRequest,
  helpers: RouteToolCallHelpers,
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

type BackendToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return fallback;
}

const PUBLIC_PROVIDER_INPUT_SCHEMA: BackendToolDescriptor['inputSchema'] = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      description: 'Operation: exec, list, fork, or coral:<agent-name>. Resume is represented as exec plus session.',
    },
    prompt: {
      type: 'string',
      description: 'Prompt to send. Required for exec and coral:* operations, optional for fork.',
    },
    session: {
      type: 'string',
      description: 'Session ID to resume with exec or to fork from an existing session.',
    },
    work_dir: {
      type: 'string',
      description: 'Working directory for execution.',
    },
    model: {
      type: 'string',
      description: 'Optional model override.',
    },
    owner: {
      type: 'string',
      description: 'Owner identifier used by coral:* agent dispatch.',
    },
  },
  required: ['op'],
};

function buildProviderToolDescriptor(name: string): BackendToolDescriptor {
  return {
    name,
    description: `Execute ${name} provider operations. Use op field to select exec, list, fork, or coral:<agent-name>; resume uses exec plus session.`,
    inputSchema: PUBLIC_PROVIDER_INPUT_SCHEMA,
  };
}

export const DISCUSS_TOOL_DESCRIPTORS: BackendToolDescriptor[] = [
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

export const KB_TOOL_DESCRIPTORS: BackendToolDescriptor[] = [
  {
    name: 'kb_search',
    description: 'Search knowledge-base notes, sources, and communities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_k: { type: 'integer', minimum: 1 },
        scope: { type: 'string', enum: ['notes', 'sources', 'communities', 'all'] },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_read',
    description: 'Read a knowledge-base note, source, community, or principle entry.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
      },
      required: ['note'],
    },
  },
  {
    name: 'kb_promote',
    description: 'Promote a memo into a new knowledge-base note.',
    inputSchema: {
      type: 'object',
      properties: {
        memo: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        domain: { type: 'string' },
        topic: { type: 'string' },
      },
      required: ['memo', 'title', 'content', 'domain', 'topic'],
    },
  },
  {
    name: 'kb_update',
    description: 'Update an existing knowledge-base note.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['note'],
    },
  },
  {
    name: 'kb_delete',
    description: 'Delete an existing knowledge-base note.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
      },
      required: ['note'],
    },
  },
  {
    name: 'kb_source_import',
    description: 'Import a staged source file into the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        stagedPath: { type: 'string' },
      },
      required: ['slug', 'stagedPath'],
    },
  },
  {
    name: 'kb_source_list',
    description: 'List imported knowledge-base sources.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kb_source_delete',
    description: 'Delete an imported knowledge-base source.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'kb_memo',
    description: 'Write a scoped knowledge-base memo.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        content: { type: 'string' },
        owner: { type: 'string' },
      },
      required: ['topic', 'content', 'owner'],
    },
  },
  {
    name: 'kb_memo_list',
    description: 'List scoped knowledge-base memos.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
      },
    },
  },
  {
    name: 'kb_memo_delete',
    description: 'Delete knowledge-base memos matching a pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        owner: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'kb_memo_purge',
    description: 'Purge scoped knowledge-base memos.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
      },
    },
  },
  {
    name: 'kb_principles',
    description: 'List or search indexed knowledge-base principles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_k: { type: 'integer', minimum: 1 },
        verbose: { type: 'boolean' },
      },
    },
  },
  {
    name: 'kb_reindex',
    description: 'Rebuild the knowledge-base search index.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export const WORKFLOW_TOOL_DESCRIPTOR: BackendToolDescriptor = {
  name: 'workflow',
  description: 'Launch a workflow pipeline over provider and coral agent steps.',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string' },
      start_prompt: { type: 'string' },
      context: { type: 'string' },
      provider: { type: 'string' },
      work_dir: { type: 'string' },
      owner: { type: 'string' },
    },
    required: ['expression', 'start_prompt'],
  },
};

export const ABORT_TOOL_DESCRIPTOR: BackendToolDescriptor = {
  name: 'abort',
  description: 'Abort one or more running jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      jobs: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    required: ['jobs'],
  },
};

/**
 * Build MCP tool descriptors for all registered providers plus built-in tools.
 * The default registry is a convenience for CLI/bridge callers that don't own a backend.
 * Backend paths should always pass their owned registry explicitly.
 */
export function getToolDescriptors(
  providerRegistry?: ProviderRegistry,
): Array<Record<string, unknown>> {
  const registry = providerRegistry ?? createBuiltInProviderRegistry();
  return [
    ...registry.getAll().map((provider) => buildProviderToolDescriptor(provider.name)),
    ...DISCUSS_TOOL_DESCRIPTORS,
    ...KB_TOOL_DESCRIPTORS,
    WORKFLOW_TOOL_DESCRIPTOR,
    ABORT_TOOL_DESCRIPTOR,
  ];
}

export async function routeToolCall(
  request: ToolRequest,
  helpers: RouteToolCallHelpers,
  kbSubsystem: KbSubsystem | null = null,
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
