import { z } from 'zod';

import { AGENT_IDENT_RE, identPattern, providerIdentPattern } from '../infra/identifiers.js';
import { retentionPolicySchema } from './entry.js';

const modelNameSchema = z
  .string()
  .regex(identPattern, 'Model name must be alphanumeric with dots, hyphens, or underscores');
const promptSchema = z.string().min(1, 'Prompt is required');
const projectRootSchema = z.string().min(1, 'Project root is required');
const ownerSchema = z.string().regex(identPattern, 'Owner must be token-safe');
const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const claudeModelCapSchema = modelNameSchema.optional();

export const providerNameSchema = z
  .string()
  .regex(providerIdentPattern, 'Provider name must be lowercase letters, digits, or hyphens');

export const agentIdentSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.endsWith('.md') ? value.slice(0, -3) : value),
  z
    .string()
    .regex(AGENT_IDENT_RE, 'Agent must be "<name>" or "<namespace>:<name>" (lowercase letters, digits, hyphens)'),
);

export const sessionCreateSchema = z
  .object({
    provider: providerNameSchema,
    prompt: promptSchema,
    projectRoot: projectRootSchema,
    model: modelNameSchema.optional(),
    agent: agentIdentSchema.optional(),
    workDir: z.string().optional(),
    owner: ownerSchema.optional(),
    effort: effortLevelSchema.optional(),
    claudeModelCap: claudeModelCapSchema,
    bypassPermissions: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    retention: retentionPolicySchema.optional(),
  })
  .strict();
