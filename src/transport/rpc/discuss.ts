import { z } from 'zod';
import { discussBidSchema, discussSpeechSchema, discussStartSchema } from '../../discuss/command-schemas.js';
import { coralEnvForwardSchema } from '../../infra/env-sanitize.js';
import { networkEnvSchema } from '../../infra/network-env.js';

const projectRootSchema = z.string().min(1, 'Project root is required');
const sessionIdSchema = z.string().min(1, 'Session ID is required');

export const discussDetailQuerySchema = z
  .object({
    projectRoot: projectRootSchema,
    view: z.enum(['control', 'audit']).optional(),
  })
  .strict();

export const discussEventsQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(0).optional(),
    projectRoot: projectRootSchema,
  })
  .strict();

export const discussDeleteQuerySchema = z
  .object({
    projectRoot: projectRootSchema,
  })
  .strict();

export const discussSessionListRequestSchema = z.object({}).strict();

export const discussSessionCreateRequestSchema = discussStartSchema
  .extend({
    projectRoot: projectRootSchema,
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
    claudeTransport: z.string().optional(),
    networkEnv: networkEnvSchema.optional(),
    coralEnv: coralEnvForwardSchema.optional(),
  })
  .strict();

export const discussSessionDetailRequestSchema = discussDetailQuerySchema.extend({
  sessionId: sessionIdSchema,
});

export const discussSessionEventsRequestSchema = discussEventsQuerySchema.extend({
  sessionId: sessionIdSchema,
});

export const discussSessionDeleteRequestSchema = discussDeleteQuerySchema.extend({
  sessionId: sessionIdSchema,
});

export const discussSessionBidRequestSchema = discussBidSchema
  .omit({ session: true })
  .extend({
    sessionId: sessionIdSchema,
    projectRoot: projectRootSchema,
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
    claudeTransport: z.string().optional(),
    networkEnv: networkEnvSchema.optional(),
    coralEnv: coralEnvForwardSchema.optional(),
  })
  .strict();

export const discussSessionSpeechRequestSchema = discussSpeechSchema
  .omit({ session: true })
  .extend({
    sessionId: sessionIdSchema,
    projectRoot: projectRootSchema,
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
    claudeTransport: z.string().optional(),
    networkEnv: networkEnvSchema.optional(),
    coralEnv: coralEnvForwardSchema.optional(),
  })
  .strict();
