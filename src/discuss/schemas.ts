/**
 * Zod schemas for MCP tool input validation — discuss/discuss_persona_seed tools.
 */

import { z } from 'zod';
import { identPattern } from '../shared/mcp-utils.js';

/** Session ID: yymmdd-HHmm-xxxx (compact timestamp + 4-char random suffix). */
export const sessionIdPattern = /^[0-9]{6}-[0-9]{4}-[a-z0-9]{4}$/;

const sessionField = z.string().regex(sessionIdPattern);
const agentNameField = z.string().regex(identPattern);

const createShape = z.object({
  op: z.literal('create'),
  topic: z.string().min(1),
  agents: z
    .array(
      z.object({
        name: agentNameField,
        persona: z.string().min(1),
      }),
    )
    .min(2)
    .max(8)
    .refine(
      (agents) => new Set(agents.map((a) => a.name)).size === agents.length,
      'Agent names must be unique',
    ),
  quota_per_epoch: z.number().int().min(1).max(10).default(3),
  recent_turns: z.number().int().min(1).max(20).default(5),
});

const bidShape = z.object({
  op: z.literal('bid'),
  session: sessionField,
  agent_name: agentNameField,
  score: z.number().int().min(0).max(100),
});

const waitShape = z.object({
  op: z.literal('wait'),
  session: sessionField,
  condition: z.enum(['all_bids', 'speech_delivered', 'action_needed']),
  timeout_seconds: z.number().min(1),
  agent_name: agentNameField.optional(),
});

const speakShape = z.object({
  op: z.literal('speak'),
  session: sessionField,
  agent_name: agentNameField,
  content: z.string().min(1),
});

const transcriptShape = z.object({
  op: z.literal('transcript'),
  session: sessionField,
  agent_name: agentNameField.optional(),
  mode: z.enum(['full', 'recent', 'summary']).default('recent'),
  last_n: z.number().int().min(1).max(50).optional(),
});

const stateShape = z.object({
  op: z.literal('state'),
  session: sessionField,
});

const endShape = z.object({
  op: z.literal('end'),
  session: sessionField,
  synthesis: z.string().optional(),
  force: z.boolean().default(false),
  reason: z.string().optional(),
});

const epochSummaryShape = z.object({
  op: z.literal('epoch_summary'),
  session: sessionField,
  epoch: z.number().int().min(1),
  summary: z.string().min(1),
});

export const discussOpSchema = z.discriminatedUnion('op', [
  createShape,
  bidShape,
  waitShape,
  speakShape,
  transcriptShape,
  stateShape,
  endShape,
  epochSummaryShape,
]);

export type DiscussOpInput = z.infer<typeof discussOpSchema>;
export type DiscussCreateInput = Omit<Extract<DiscussOpInput, { op: 'create' }>, 'op'>;

// discuss_persona_seed — Generate k-DPP diverse persona assignments
export const discussPersonaSeedSchema = z.object({
  controversy_axes: z.array(z.object({
    axis: z.string().min(1),
    positions: z.array(z.string().min(1)).min(1).max(10)
      .refine(
        (positions) => new Set(positions).size === positions.length,
        'Positions within an axis must be unique',
      ),
  })).min(1).max(10)
    .refine(
      (axes) => new Set(axes.map((a) => a.axis)).size === axes.length,
      'Axis names must be unique',
    ),
  n: z.number().int().min(1).max(8),
  seed: z.number().int().nullable().default(null),
});

export type DiscussPersonaSeedInput = z.infer<typeof discussPersonaSeedSchema>;
