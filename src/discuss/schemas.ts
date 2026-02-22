/**
 * Zod schemas for MCP tool input validation - discuss/discuss_lead tools.
 */

import { z } from 'zod';
import { identPattern } from '../shared/mcp-utils.js';

/** Session ID: yymmdd-HHmm-xxxx (compact timestamp + 4-char random suffix). */
export const sessionIdPattern = /^[0-9]{6}-[0-9]{4}-[a-z0-9]{4}$/;

const nonEmptyString = z.string().min(1);
const agentNameField = z.string().regex(identPattern);
const sessionIdField = z.string().regex(sessionIdPattern);

function hasUniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const bidShape = z.object({
  op: z.literal('bid'),
  session: sessionIdField,
  agent_name: agentNameField,
  score: z.number().int().min(0).max(100),
}).strict();

const speakShape = z.object({
  op: z.literal('speak'),
  session: sessionIdField,
  agent_name: agentNameField,
  content: z.string().min(1),
}).strict();

export const discussAgentOpSchema = z.discriminatedUnion('op', [bidShape, speakShape]);

const seedShape = z.object({
  op: z.literal('_1_seed'),
  controversy_axes: z.array(z.object({
    axis: nonEmptyString,
    positions: z.array(nonEmptyString).min(1).max(10)
      .refine((positions) => hasUniqueValues(positions), 'Positions within an axis must be unique'),
  })).min(1).max(10)
    .refine((axes) => hasUniqueValues(axes.map((axis) => axis.axis)), 'Axis names must be unique'),
  n: z.number().int().min(1).max(8),
  seed: z.number().int().nullable().default(null),
}).strict();

const createShape = z.object({
  op: z.literal('_2_create'),
  topic: z.string().min(1),
  agents: z
    .array(
      z.object({
        name: agentNameField,
        persona: nonEmptyString,
      }),
    )
    .min(2)
    .max(8)
    .refine(
      (agents) => hasUniqueValues(agents.map((agent) => agent.name)),
      'Agent names must be unique',
  ),
}).strict();

const stepShape = z.object({
  op: z.literal('_3_step'),
  session: sessionIdField,
  timeout_seconds: z.number().min(1).max(120),
  force_stop: z.boolean().default(false),
}).strict();

const transcriptShape = z.object({
  op: z.literal('_4_transcript'),
  session: sessionIdField,
  mode: z.enum(['full', 'recent', 'summary']).default('recent'),
  last_n: z.number().int().min(1).max(50).optional(),
}).strict();

const epochSummaryShape = z.object({
  op: z.literal('_5_epoch'),
  session: sessionIdField,
  summary: z.string().min(1),
}).strict();

const stateShape = z.object({
  op: z.literal('_6_state'),
  session: sessionIdField,
}).strict();

const endShape = z.object({
  op: z.literal('_7_end'),
  session: sessionIdField,
  synthesis: z.string().optional(),
  force: z.boolean().default(false),
  reason: z.string().optional(),
}).strict();

export const discussLeadOpSchema = z.discriminatedUnion('op', [
  seedShape,
  createShape,
  stepShape,
  transcriptShape,
  epochSummaryShape,
  stateShape,
  endShape,
]);

export type DiscussAgentOpInput = z.infer<typeof discussAgentOpSchema>;
export type DiscussLeadOpInput = z.infer<typeof discussLeadOpSchema>;
export type DiscussCreateInput = Omit<Extract<DiscussLeadOpInput, { op: '_2_create' }>, 'op'>;

export type DiscussPersonaSeedInput = z.infer<typeof seedShape>;
