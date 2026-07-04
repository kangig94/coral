import { z } from 'zod';

import type { ControversyAxis } from './session-types.js';

const ControversyAxisSchema = z.object({
  axis: z.string(),
  positions: z.array(z.string()),
}) satisfies z.ZodType<ControversyAxis>;

const DemographicsSchema = z.object({
  origin_weights: z.record(z.number()),
  outlier_ratio: z.number().optional(),
});

export const discussSeedSchema = z
  .object({
    controversy_axes: z.array(ControversyAxisSchema).min(1),
    n: z.number().int().min(1).max(20),
    demographics: DemographicsSchema.optional(),
    seed: z.number().int(),
  })
  .strict();

const AgentInputSchema = z.object({
  name: z.string(),
  persona: z.string(),
  participation: z.enum(['required', 'observer']).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

const DiscussAgentsSchema = z
  .array(AgentInputSchema)
  .min(2)
  .refine((agents) => agents.some((agent) => (agent.participation ?? 'required') === 'required'), {
    message: 'At least one required agent is needed to run a discussion.',
  });

export const discussStartSchema = z.object({
  topic: z.string().min(1),
  agents: DiscussAgentsSchema,
  config: z
    .object({
      min_bid_delay_ms: z.number().int().min(0).optional(),
    })
    .optional(),
});

export const discussBidSchema = z.object({
  session: z.string().min(1),
  agent_name: z.string().min(1),
  score: z.number().int().min(0).max(100),
  thought: z.string(),
  content: z.undefined().optional(),
});

export const discussSpeechSchema = z.object({
  session: z.string().min(1),
  agent_name: z.string().min(1),
  content: z.string(),
  score: z.undefined().optional(),
  thought: z.undefined().optional(),
});
