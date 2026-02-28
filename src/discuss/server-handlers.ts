import { textResult, jsonResult, resultToMcp, type McpResult } from '../shared/mcp-utils.js';
import { z } from 'zod';
import { SessionStore } from './session-store.js';
import {
  applyEnd,
  applySynthesis,
  applyEpochSummary,
  initSession,
  DEFAULT_BID_THRESHOLD,
  DEFAULT_MAX_EPOCHS,
  DEFAULT_QUOTA_PER_EPOCH,
} from './state-machine.js';
import { formatAgentView, formatRecent, formatSummary } from './transcript.js';
import { seedPersonas } from './persona-seed.js';
import { drawUInt32 } from './util/rng.js';
import {
  discussAgentOpSchema,
  discussLeadOpSchema,
  type DiscussLeadOpInput,
} from './schemas.js';
import type { DiscussState, Result } from './types.js';
import { handleAgentOp } from './handlers/bid.js';
import { handleStep } from './handlers/step.js';
import { nowIsoString } from './util/time.js';

type ToolParseResult<T> = { ok: true; value: T } | { ok: false; value: McpResult };

function parseToolInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  rawArgs: Record<string, unknown>,
): ToolParseResult<T> {
  const parsed = schema.safeParse(rawArgs);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const maybeOp = (rawArgs as { op?: unknown }).op;
  if (parsed.error.issues.some((issue) => issue.code === 'invalid_union_discriminator') && maybeOp !== undefined) {
    return { ok: false, value: jsonResult({ error: 'unknown_op', op: maybeOp }) };
  }

  throw parsed.error;
}

function envInt(key: string, min: number, max: number, fallback: number): number {
  const raw = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

function formatTranscriptForMode(
  input: Extract<DiscussLeadOpInput, { op: '_4_transcript' }>,
  state: DiscussState,
): string {
  switch (input.mode) {
    case 'full':
      return formatAgentView(state.transcript, state.agents);
    case 'summary':
      return formatSummary(state.transcript, state.agents);
    default:
      return formatRecent(state.transcript, input.last_n ?? 5, state.agents);
  }
}

async function applyStatusChange(
  sessionId: string,
  store: SessionStore,
  apply: (state: DiscussState) => Result<DiscussState>,
): Promise<McpResult> {
  const sessionDir = store.resolveOrError(sessionId);
  if (typeof sessionDir !== 'string') return sessionDir;

  const updated = await store.withLock<Result<{ status: string }>>(sessionDir, async () => {
    const state = store.load(sessionDir);
    const result = apply(state);
    if (!result.ok) return result;
    if (result.value !== state) {
      store.save(sessionDir, result.value);
    }
    return { ok: true, value: { status: result.value.status } };
  });

  return resultToMcp(updated);
}

export const tools = [
  {
    name: 'discuss',
    description: 'Discussion agent tool. Use op field to select operation: bid (submit score), speak (record speech).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: { type: 'string', enum: ['bid', 'speak'] },
        session: { type: 'string', description: 'Session ID' },
        agent_name: { type: 'string', description: 'Agent name' },
        score: { type: 'number', minimum: 0, maximum: 100 },
        thought: { type: 'string', description: 'Current thinking when bidding — required for bid op (Zod enforced)' },
        content: { type: 'string', description: 'Speech content (speak)' },
      },
      required: ['op', 'session', 'agent_name'],
    },
  },
  {
    name: 'discuss_lead',
    description:
      'Discussion moderator tool. Ops: _1_seed (persona sampling), _2_create, _3_step (bid collect / speech wait), _4_transcript, _5_epoch, _6_state, _7_end, _8_synthesize.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: {
          type: 'string',
          enum: ['_1_seed', '_2_create', '_3_step', '_4_transcript', '_5_epoch', '_6_state', '_7_end'],
        },
        topic: { type: 'string', description: 'Discussion topic (_2_create)' },
        agents: {
          type: 'array',
          description: 'Agent list (_2_create)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              persona: { type: 'string' },
              participation: { type: 'string', enum: ['required', 'observer'] },
            },
            required: ['name', 'persona'],
          },
          minItems: 2,
          maxItems: 8,
        },
        min_bid_delay_ms: {
          type: 'number',
          minimum: 0,
          maximum: 30000,
          description: 'Soft observer bid wait ceiling ms after required bids complete (_2_create)',
        },
        controversy_axes: {
          type: 'array',
          description: 'Persona seed axes (_1_seed)',
          items: {
            type: 'object',
            properties: {
              axis: { type: 'string' },
              positions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
            },
            required: ['axis', 'positions'],
          },
          minItems: 1,
          maxItems: 10,
        },
        n: { type: 'integer', minimum: 1, maximum: 8, description: 'Seed count (_1_seed)' },
        demographics: {
          type: 'object',
          description: 'Domain-aware demographics for persona origins (_1_seed)',
          properties: {
            origin_weights: {
              type: 'object',
              description: 'Origin weights, e.g. {"US": 0.3, "DE": 0.2} or {"academic": 0.5, "industry": 0.5}',
              additionalProperties: { type: 'number', exclusiveMinimum: 0 },
            },
            outlier_ratio: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Fraction of outlier personas (default: 0.2)',
            },
          },
          required: ['origin_weights'],
        },
        seed: { type: ['integer', 'null'], description: 'Seed value (_1_seed)' },
        session: { type: 'string', description: 'Session ID' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 120, description: '_3_step timeout (seconds)' },
        force_stop: { type: 'boolean', description: '_3_step timeout escalation flag' },
        mode: { type: 'string', enum: ['full', 'recent', 'summary'], description: '_4_transcript' },
        last_n: { type: 'integer', minimum: 1, maximum: 50, description: 'Override recent turns (_4_transcript)' },
        summary: { type: 'string', description: 'Epoch summary (_5_epoch)' },
        synthesis: { type: 'string', description: 'Synthesis text (_8_synthesize)' },
        force: { type: 'boolean', description: 'Force end during speaking (_7_end)' },
        reason: { type: 'string', description: 'Force reason (_7_end)' },
      },
      required: ['op'],
    },
  },
];

async function handleSeed(input: Extract<DiscussLeadOpInput, { op: '_1_seed' }>): Promise<McpResult> {
  const seed = input.seed ?? drawUInt32(Math.random);
  return jsonResult(seedPersonas({ ...input, seed }));
}

async function handleCreate(
  input: Omit<Extract<DiscussLeadOpInput, { op: '_2_create' }>, 'op'>,
  store: SessionStore,
): Promise<McpResult> {
  if (!input.agents.some((a) => a.participation === 'required')) {
    return jsonResult({ error: 'no_required_agents', message: 'At least one agent must have participation: required' });
  }
  store.cleanupExpiredSessions();
  const now = nowIsoString();
  const bidThreshold = envInt('CORAL_DISCUSS_BID_THRESHOLD', 1, 100, DEFAULT_BID_THRESHOLD);
  const maxEpochs = envInt('CORAL_DISCUSS_MAX_EPOCHS', 1, 10, DEFAULT_MAX_EPOCHS);
  const quotaPerEpoch = envInt('CORAL_DISCUSS_QUOTA_PER_EPOCH', 1, 10, DEFAULT_QUOTA_PER_EPOCH);

  const state = initSession(input, now, bidThreshold, maxEpochs, quotaPerEpoch);
  const { sessionId, fullPath } = store.createSessionDir(input.topic);
  state.session_id = sessionId;

  await store.withLock(fullPath, async () => {
    store.initTranscript(fullPath, input.topic, state.agents);
    store.save(fullPath, state);
  });

  return jsonResult({
    session_id: sessionId,
    session_dir: fullPath,
    team_name: `coral-dc-${sessionId}`,
    topic: input.topic,
    status: state.status,
    bid_threshold: state.bid_threshold,
    max_epochs: state.max_epochs,
    min_bid_delay_ms: state.min_bid_delay_ms,
    agents: Object.keys(state.agents),
  });
}

async function handleTranscript(
  input: Extract<DiscussLeadOpInput, { op: '_4_transcript' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = store.resolveOrError(input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const state = await store.loadLocked(sessionDir);
  return textResult(formatTranscriptForMode(input, state));
}

async function handleEpoch(
  input: Extract<DiscussLeadOpInput, { op: '_5_epoch' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = store.resolveOrError(input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const applied = await store.withLock<Result<{ recorded: true; epoch: number }>>(sessionDir, async () => {
    const state = store.load(sessionDir);
    const result = applyEpochSummary(state, input.summary, nowIsoString());
    if (!result.ok) return result;
    store.save(sessionDir, result.value);
    return { ok: true, value: { recorded: true, epoch: state.epoch } };
  });

  return resultToMcp(applied);
}

async function handleState(
  input: Extract<DiscussLeadOpInput, { op: '_6_state' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = store.resolveOrError(input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const state = await store.loadLocked(sessionDir);

  return jsonResult({
    session_id: state.session_id,
    topic: state.topic,
    status: state.status,
    step: state.step,
    epoch: state.epoch,
    current_speaker: state.current_speaker,
    speaker_type: state.speaker_type,
    cold_start: state.cold_start,
    bid_threshold: state.bid_threshold,
    hold_count: state.hold_count,
    agents: Object.fromEntries(
      Object.entries(state.agents).map(([name, agent]) => [
        name,
        {
          display_name: agent.display_name,
          participation: agent.participation,
          total_speaks: agent.total_speaks,
          quota_remaining: agent.quota_remaining,
          fallback_used: agent.fallback_used,
          banned: agent.banned,
        },
      ]),
    ),
    pending_bidders: state.pending_bidders,
    total_agents: Object.keys(state.agents).length,
    min_bid_delay_ms: state.min_bid_delay_ms,
  });
}

async function handleEnd(
  input: Extract<DiscussLeadOpInput, { op: '_7_end' }>,
  store: SessionStore,
): Promise<McpResult> {
  if (input.force && !input.reason?.trim()) {
    return textResult('reason is required when force=true', true);
  }

  return applyStatusChange(input.session, store, (state) =>
    applyEnd(
      state,
      {
        force: input.force,
        reason: input.reason,
      },
      nowIsoString(),
    ),
  );
}

async function handleSynthesize(
  input: Extract<DiscussLeadOpInput, { op: '_8_synthesize' }>,
  store: SessionStore,
): Promise<McpResult> {
  return applyStatusChange(input.session, store, (state) => applySynthesis(state, input.synthesis, nowIsoString()));
}

async function handleDiscussLeadOp(input: DiscussLeadOpInput, store: SessionStore): Promise<McpResult> {
  switch (input.op) {
    case '_1_seed':
      return handleSeed(input);
    case '_2_create':
      return handleCreate(input, store);
    case '_3_step':
      return handleStep(input, store);
    case '_4_transcript':
      return handleTranscript(input, store);
    case '_5_epoch':
      return handleEpoch(input, store);
    case '_6_state':
      return handleState(input, store);
    case '_7_end':
      return handleEnd(input, store);
    case '_8_synthesize':
      return handleSynthesize(input, store);
    default:
      return jsonResult({ error: 'invalid_op' });
  }
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
  store: SessionStore,
): Promise<McpResult> {
  try {
    switch (name) {
      case 'discuss': {
        const parsed = parseToolInput(discussAgentOpSchema, rawArgs);
        if (!parsed.ok) return parsed.value;
        return handleAgentOp(parsed.value, store);
      }

      case 'discuss_lead': {
        const parsed = parseToolInput(discussLeadOpSchema, rawArgs);
        if (!parsed.ok) return parsed.value;
        return handleDiscussLeadOp(parsed.value, store);
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Error: ${message}`, true);
  }
}
