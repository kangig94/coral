import { z } from 'zod';
import { workflowCommandSchema } from '../../workflow/input.js';

const projectRootSchema = z.string().min(1, 'Project root is required');
const modelNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, 'Model name must be alphanumeric with dots, hyphens, or underscores');

export const workflowRequestSchema = workflowCommandSchema
  .extend({
    projectRoot: projectRootSchema,
    claudeModelCap: modelNameSchema.optional(),
  })
  .strict();
