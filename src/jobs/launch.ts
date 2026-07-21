import { z } from 'zod';

import { providerInstructionSchema, type ProviderInstruction } from '../providers/contract.js';
import { continuityRefSchema } from '../sessions/continuity.js';
import { retentionPolicySchema, type RetentionPolicy } from '../sessions/entry.js';
import type { LaunchPool } from './contracts/admission.js';
import { providerCredentialSetSchema } from '../runtime/provider-credentials.js';

export const sourceImportReadinessValues = ['commit', 'base-search', 'active-vector', 'all-equipped'] as const;
const sourceImportReadinessSchema = z.enum(sourceImportReadinessValues);
export type SourceImportReadiness = z.infer<typeof sourceImportReadinessSchema>;
export type KbJobOperation = 'kb.source_import' | 'kb.reindex' | 'kb.community_summary';

export type LaunchDecision =
  | { status: 'running'; job: string; session: string }
  | { status: 'queued'; job: string; session: string; message?: undefined }
  | { status: 'rejected'; phase: 'preflight'; code: string; message: string };

/**
 * Coordinator response shape when a launch request is accepted (running or queued).
 * Returned over IPC and HTTP for sessions.create / workflow.run.
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

const providerLaunchRequestSchema = z
  .object({
    prompt: z.string(),
    name: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    bypassPermissions: z.boolean(),
    systemPrompt: z.string().optional(),
    conversationRef: continuityRefSchema.optional(),
    instruction: providerInstructionSchema.optional(),
    retention: retentionPolicySchema.optional(),
    coralEnv: z.record(z.string()),
  })
  .strict();

const providerOrWorkflowLaunchBaseSchema = z
  .object({
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    providerAction: z.enum(['exec', 'resume']),
    projectRoot: z.string(),
    backendNamespace: z.string(),
    bundleHash: z.string().optional(),
    pool: z.string(),
    enqueueSequence: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();

const providerJobLaunchRequestBodySchema = providerOrWorkflowLaunchBaseSchema.extend({
  jobKind: z.literal('provider'),
  request: providerLaunchRequestSchema,
});

const workflowJobLaunchRequestBodySchema = providerOrWorkflowLaunchBaseSchema.extend({
  jobKind: z.literal('workflow'),
  request: providerLaunchRequestSchema.extend({ providerCredentials: providerCredentialSetSchema }),
});

const kbJobLaunchBaseSchema = z.object({
  projectRoot: z.string(),
  backendNamespace: z.string(),
  bundleHash: z.string().optional(),
  jobKind: z.literal('kb'),
  pool: z.string(),
  enqueueSequence: z.number().int().nonnegative(),
  createdAt: z.string(),
});

const kbSourceImportJobRequestSchema = z
  .object({
    filePath: z.string().min(1),
    slug: z.string().optional(),
    readiness: sourceImportReadinessSchema,
  })
  .strict();

const kbSourceImportJobLaunchRequestBodySchema = kbJobLaunchBaseSchema
  .extend({
    operation: z.literal('kb.source_import'),
    request: kbSourceImportJobRequestSchema,
  })
  .strict();

const kbReindexJobLaunchRequestBodySchema = kbJobLaunchBaseSchema
  .extend({
    operation: z.literal('kb.reindex'),
    request: z.object({}).strict(),
  })
  .strict();

const kbCommunitySummaryJobLaunchRequestBodySchema = kbJobLaunchBaseSchema
  .extend({
    operation: z.literal('kb.community_summary'),
    request: z.object({}).strict(),
  })
  .strict();

export const jobLaunchRequestBodySchema = z.union([
  providerJobLaunchRequestBodySchema,
  workflowJobLaunchRequestBodySchema,
  kbSourceImportJobLaunchRequestBodySchema,
  kbReindexJobLaunchRequestBodySchema,
  kbCommunitySummaryJobLaunchRequestBodySchema,
]);

export type ProviderJobLaunchRequestBody = z.infer<typeof providerJobLaunchRequestBodySchema>;
export type KbSourceImportJobRequest = z.infer<typeof kbSourceImportJobRequestSchema>;
export type JobLaunchRequestBody = z.infer<typeof jobLaunchRequestBodySchema>;
