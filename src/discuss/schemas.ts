import { z } from 'zod';

export const ControversyAxisSchema = z.object({
  axis: z.string(),
  positions: z.array(z.string()),
});
export type ControversyAxis = z.infer<typeof ControversyAxisSchema>;

export const DemographicsSchema = z.object({
  origin_weights: z.record(z.number()),
  outlier_ratio: z.number().optional(),
});
export type Demographics = z.infer<typeof DemographicsSchema>;

export const discussSeedSchema = z.object({
  controversy_axes: z.array(ControversyAxisSchema).min(1),
  n: z.number().int().min(1).max(20),
  demographics: DemographicsSchema.optional(),
  seed: z.number().int(),
});
export type DiscussSeedInput = z.infer<typeof discussSeedSchema>;

export const AgentInputSchema = z.object({
  name: z.string(),
  persona: z.string(),
  participation: z.enum(['required', 'observer']).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

export const discussStartSchema = z.object({
  topic: z.string().min(1),
  agents: z.array(AgentInputSchema).min(2),
  config: z
    .object({
      min_bid_delay_ms: z.number().int().min(0).optional(),
    })
    .optional(),
});
export type DiscussStartInput = z.infer<typeof discussStartSchema>;

export const discussParticipateBidSchema = z.object({
  session: z.string().min(1),
  agent_name: z.string().min(1),
  score: z.number().int().min(0).max(100),
  thought: z.string(),
  content: z.undefined().optional(),
});
export type DiscussParticipateBidInput = z.infer<typeof discussParticipateBidSchema>;

export const discussParticipateSpeechSchema = z.object({
  session: z.string().min(1),
  agent_name: z.string().min(1),
  content: z.string(),
  score: z.undefined().optional(),
  thought: z.undefined().optional(),
});
export type DiscussParticipateSpeechInput = z.infer<typeof discussParticipateSpeechSchema>;

export const discussParticipateSchema = z.union([discussParticipateBidSchema, discussParticipateSpeechSchema]);
export type DiscussParticipateInput = z.infer<typeof discussParticipateSchema>;
