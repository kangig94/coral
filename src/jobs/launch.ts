import { z } from 'zod';

import { providerInstructionSchema, type ProviderInstruction } from '../providers/contract.js';
import { retentionPolicySchema, type RetentionPolicy } from '../sessions/entry.js';
import type { LaunchPool } from './contracts/admission.js';

export const sourceImportReadinessValues = ['commit', 'base-search', 'active-vector', 'all-equipped'] as const;
export const sourceImportReadinessSchema = z.enum(sourceImportReadinessValues);
export type SourceImportReadiness = z.infer<typeof sourceImportReadinessSchema>;
export type KbJobOperation = 'kb.source_import' | 'kb.reindex';

export type LaunchDecision =
  | { status: 'running'; job: string; session: string }
  | { status: 'queued'; job: string; session: string; message?: undefined }
  | { status: 'rejected'; phase: 'preflight'; code: string; message: string };

/**
 * Coordinator response shape when a launch request is accepted (running or queued).
 * Returned over IPC and HTTP for sessions.create / sessions.message / sessions.fork
 * / workflow.run.
 */
export type AcceptedLaunchResponse = {
  session: string;
  job: string;
  launchState: 'running' | 'queued';
};

export function rejectLaunch(code: string, message: string): LaunchDecision {
  return {
    status: 'rejected',
    phase: 'preflight',
    code,
    message,
  };
}

export interface JobLaunchRequest {
  prompt: string;
  name?: string;
  model?: string;
  cwd?: string;
  jobId?: string;
  workflowSlotId?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  /**
   * The workflow job that owns the plan slot this child is filling. By spec
   * §6.1 line 813 convention `workflowJobId === workflowId`, so this value
   * also becomes `refs.workflowId` on the resulting `job.launch.requested`
   * envelope — the launch path in `store.ts` is the producer.
   */
  parentWorkflowJobId?: string;
  agent?: string;
  pool?: LaunchPool;
  retention?: RetentionPolicy;
}

export interface JobResumeRequest extends Omit<JobLaunchRequest, 'retention'> {
  sessionId: string;
  provider?: string;
}

export interface JobForkRequest extends Omit<JobLaunchRequest, 'prompt' | 'agent' | 'pool' | 'retention'> {
  sessionId: string;
  provider?: string;
  prompt?: string;
}

export const providerJobLaunchRequestBodySchema = z
  .object({
    sessionId: z.string(),
    provider: z.string(),
    providerAction: z.enum(['exec', 'resume', 'fork']),
    projectRoot: z.string(),
    backendNamespace: z.string(),
    bundleHash: z.string().optional(),
    jobKind: z.enum(['provider', 'workflow']),
    pool: z.string(),
    enqueueSequence: z.number().int().nonnegative(),
    request: z
      .object({
        prompt: z.string(),
        name: z.string().optional(),
        model: z.string().optional(),
        cwd: z.string(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        bypassPermissions: z.boolean(),
        systemPrompt: z.string().optional(),
        conversationRef: z.string().optional(),
        instruction: providerInstructionSchema.optional(),
        retention: retentionPolicySchema.optional(),
        coralEnv: z.record(z.string()),
      })
      .strict(),
    createdAt: z.string(),
  })
  .strict();

const kbJobLaunchBaseSchema = z.object({
  projectRoot: z.string(),
  backendNamespace: z.string(),
  bundleHash: z.string().optional(),
  jobKind: z.literal('kb'),
  pool: z.string(),
  enqueueSequence: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export const kbSourceImportJobRequestSchema = z
  .object({
    filePath: z.string().min(1),
    slug: z.string().optional(),
    readiness: sourceImportReadinessSchema,
  })
  .strict();

export const kbSourceImportJobLaunchRequestBodySchema = kbJobLaunchBaseSchema
  .extend({
    operation: z.literal('kb.source_import'),
    request: kbSourceImportJobRequestSchema,
  })
  .strict();

export const kbReindexJobLaunchRequestBodySchema = kbJobLaunchBaseSchema
  .extend({
    operation: z.literal('kb.reindex'),
    request: z.object({}).strict(),
  })
  .strict();

export const jobLaunchRequestBodySchema = z.union([
  providerJobLaunchRequestBodySchema,
  kbSourceImportJobLaunchRequestBodySchema,
  kbReindexJobLaunchRequestBodySchema,
]);

export type ProviderJobLaunchRequestBody = z.infer<typeof providerJobLaunchRequestBodySchema>;
export type KbSourceImportJobLaunchRequestBody = z.infer<typeof kbSourceImportJobLaunchRequestBodySchema>;
export type KbReindexJobLaunchRequestBody = z.infer<typeof kbReindexJobLaunchRequestBodySchema>;
export type KbSourceImportJobRequest = z.infer<typeof kbSourceImportJobRequestSchema>;
export type JobLaunchRequestBody = z.infer<typeof jobLaunchRequestBodySchema>;
