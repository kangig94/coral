import { z } from 'zod';

import { providerInstructionSchema, type ProviderInstruction } from '../providers/contract.js';
import { retentionPolicySchema, type RetentionPolicy } from '../sessions/entry.js';
import { LAUNCH_POOLS, type LaunchPool } from './contracts/admission.js';
import { discussionRunDescriptorSchema, type DiscussionRunDescriptor } from './discussion-run.js';
import { executionOwnerSchema, type ExecutionOwner } from '../runtime/execution-owner.js';

export const sourceImportReadinessValues = ['commit', 'base-search', 'active-vector', 'all-equipped'] as const;
const sourceImportReadinessSchema = z.enum(sourceImportReadinessValues);
export type SourceImportReadiness = z.infer<typeof sourceImportReadinessSchema>;
export type KbJobOperation = 'kb.source_import' | 'kb.reindex' | 'kb.community_summary';

export type AcceptedProviderSessionLaunchDecision =
  | { kind: 'provider-session'; status: 'running'; jobId: string; sessionId: string }
  | { kind: 'provider-session'; status: 'queued'; jobId: string; sessionId: string; message?: undefined };

export type AcceptedWorkflowLaunchDecision =
  | { kind: 'workflow'; status: 'running'; jobId: string; workflowId: string }
  | { kind: 'workflow'; status: 'queued'; jobId: string; workflowId: string; message?: undefined };

export type RejectedLaunchDecision = {
  status: 'rejected';
  phase: 'preflight';
  code: string;
  message: string;
};

export type ProviderSessionLaunchDecision = AcceptedProviderSessionLaunchDecision | RejectedLaunchDecision;
export type WorkflowLaunchDecision = AcceptedWorkflowLaunchDecision | RejectedLaunchDecision;
export type LaunchDecision = ProviderSessionLaunchDecision | AcceptedWorkflowLaunchDecision;

/**
 * Coordinator response shape when a launch request is accepted (running or queued).
 * Returned over IPC and HTTP for sessions.create / workflow.run.
 */
export type AcceptedLaunchResponse =
  | {
      kind: 'provider-session';
      sessionId: string;
      jobId: string;
      launchState: 'running' | 'queued';
    }
  | {
      kind: 'workflow';
      workflowId: string;
      jobId: string;
      launchState: 'running' | 'queued';
    };

export function rejectLaunch(code: string, message: string): RejectedLaunchDecision {
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
  workflowSlotGeneration?: number;
  replacesWorkflowJobId?: string;
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
  owner?: ExecutionOwner;
  discussionRun?: DiscussionRunDescriptor;
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
    instruction: providerInstructionSchema.optional(),
    retention: retentionPolicySchema.optional(),
    coralEnv: z.record(z.string()),
  })
  .strict();

const workflowLaunchRequestSchema = z
  .object({
    prompt: z.string(),
    cwd: z.string(),
    bypassPermissions: z.boolean(),
    coralEnv: z.record(z.string()),
  })
  .strict();

const providerJobLaunchBaseSchema = z
  .object({
    owner: executionOwnerSchema,
    discussionRun: discussionRunDescriptorSchema.optional(),
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    providerAction: z.enum(['exec', 'resume']),
    projectRoot: z.string(),
    backendNamespace: z.string(),
    bundleHash: z.string().optional(),
    pool: z.enum(LAUNCH_POOLS),
    enqueueSequence: z.number().int().nonnegative(),
    createdAt: z.string(),
    workflowSlotGeneration: z.number().int().nonnegative().optional(),
    replacesWorkflowJobId: z.string().min(1).optional(),
  })
  .strict();

const providerJobLaunchRequestBodySchema = providerJobLaunchBaseSchema.extend({
  jobKind: z.literal('provider'),
  request: providerLaunchRequestSchema,
});

const workflowJobLaunchRequestBodySchema = z
  .object({
    owner: executionOwnerSchema,
    projectRoot: z.string(),
    backendNamespace: z.string(),
    bundleHash: z.string().optional(),
    jobKind: z.literal('workflow'),
    pool: z.enum(LAUNCH_POOLS),
    enqueueSequence: z.number().int().nonnegative(),
    request: workflowLaunchRequestSchema,
    createdAt: z.string(),
  })
  .strict();

const kbJobLaunchBaseSchema = z.object({
  owner: executionOwnerSchema,
  projectRoot: z.string(),
  backendNamespace: z.string(),
  bundleHash: z.string().optional(),
  jobKind: z.literal('kb'),
  pool: z.enum(LAUNCH_POOLS),
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

export const kbJobLaunchPayloadSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('kb.source_import'), request: kbSourceImportJobRequestSchema }).strict(),
  z.object({ operation: z.literal('kb.reindex'), request: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('kb.community_summary'), request: z.object({}).strict() }).strict(),
]);

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
