import { z } from 'zod';

import { providerBindingEnvelopeSchema } from '../infra/provider-binding-envelope.js';
import { providerInstructionSchema, type ProviderInstruction } from '../providers/contract.js';
import { retentionPolicySchema, type RetentionPolicy } from './conversation/entry.js';
import { LAUNCH_POOLS, type LaunchPool } from './contracts/admission.js';
import { discussionRunDescriptorSchema, type DiscussionRunDescriptor } from './discussion-run.js';
import { executionOwnerSchema, type ExecutionOwner } from '../runtime/execution-owner.js';
import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';

export const sourceImportReadinessValues = ['commit', 'base-search', 'active-vector', 'all-equipped'] as const;
const sourceImportReadinessSchema = z.enum(sourceImportReadinessValues);
export type SourceImportReadiness = z.infer<typeof sourceImportReadinessSchema>;
export type KbJobOperation = 'kb.source_import' | 'kb.reindex' | 'kb.community_summary';

export type CommittedExecutionRequest = { requestedSeq: number; epochKey: string };

export type AcceptedProviderJobLaunchDecision = CommittedExecutionRequest &
  (
    | { kind: 'provider-session'; status: 'running'; jobId: string }
    | { kind: 'provider-session'; status: 'queued'; jobId: string; message?: undefined }
  );

export type AcceptedWorkflowLaunchDecision = CommittedExecutionRequest &
  (
    | { kind: 'workflow'; status: 'running'; jobId: string; workflowId: string }
    | { kind: 'workflow'; status: 'queued'; jobId: string; workflowId: string; message?: undefined }
  );

export type RefusedLaunchDecision = {
  status: 'refused';
  code: string;
  message: string;
};

export type UndeterminedLaunchDecision = {
  status: 'undetermined';
  code: string;
  message: string;
};

export type ProviderJobLaunchDecision =
  | AcceptedProviderJobLaunchDecision
  | RefusedLaunchDecision
  | UndeterminedLaunchDecision;
export type WorkflowLaunchDecision = AcceptedWorkflowLaunchDecision | RefusedLaunchDecision;
export type LaunchDecision = ProviderJobLaunchDecision | AcceptedWorkflowLaunchDecision;

/**
 * Coordinator response shape when a launch request is accepted (running or queued).
 * Returned over IPC and HTTP for sessions.create / workflow.run.
 */
const acceptedLaunchFields = {
  jobId: z.string().min(1),
  requestedSeq: z.number().int().positive().safe(),
  epochKey: z.string().min(1),
  launchState: z.enum(['running', 'queued']),
};

export const acceptedLaunchResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...acceptedLaunchFields, kind: z.literal('provider-session') }).strict(),
  z.object({ ...acceptedLaunchFields, kind: z.literal('workflow'), workflowId: z.string().min(1) }).strict(),
]);

export type AcceptedLaunchResponse = z.infer<typeof acceptedLaunchResponseSchema>;

export function refuseLaunch(code: string, message: string): RefusedLaunchDecision {
  return {
    status: 'refused',
    code,
    message,
  };
}

export function undeterminedLaunch(code: string, message: string): UndeterminedLaunchDecision {
  return {
    status: 'undetermined',
    code,
    message,
  };
}

export interface JobLaunchRequest {
  prompt: string;
  name?: string;
  model?: string;
  cwd?: CanonicalWorkDir;
  jobId?: string;
  workflowSlotId?: string;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  parentWorkflowJobId?: string;
  agent?: string;
  pool?: LaunchPool;
  retention?: RetentionPolicy;
  owner?: ExecutionOwner;
  discussionRun?: DiscussionRunDescriptor;
}

export interface JobResumeRequest extends Omit<JobLaunchRequest, 'retention' | 'cwd' | 'model'> {
  jobId: string;
  originatingClientMessageId?: string;
  provider?: string;
}

export const executionOrdinalSchema = z.number().int().positive().safe();

const controllerProfileSchema = z
  .object({ owner: z.string().optional(), effort: z.string().optional(), claudeModelCap: z.string().optional() })
  .strict();

export const jobConversationFacetSchema = z
  .object({
    provider: z.string().min(1),
    binding: providerBindingEnvelopeSchema,
    cwd: canonicalWorkDirWireSchema,
    name: z.string().min(1),
    model: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    agent: z.string().optional(),
    instruction: providerInstructionSchema.optional(),
    bypassPermissions: z.boolean(),
    systemPrompt: z.string().optional(),
    retention: retentionPolicySchema,
    controllerProfile: controllerProfileSchema.optional(),
  })
  .strict()
  .superRefine((facet, ctx) => {
    if (facet.provider !== facet.binding.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['binding', 'provider'],
        message: 'Binding provider must match the conversation provider.',
      });
    }
  })
  .describe('job-conversation-provider-binding-match-v1');

const jobOpenedBase = {
  owner: executionOwnerSchema,
  projectRoot: z.string().min(1),
  createdAt: z.string().datetime(),
};

export const jobOpenedBodySchema = z.discriminatedUnion('jobKind', [
  z
    .object({
      ...jobOpenedBase,
      jobKind: z.literal('provider'),
      conversation: jobConversationFacetSchema,
      workflowSlotId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...jobOpenedBase,
      jobKind: z.literal('workflow'),
      cwd: canonicalWorkDirWireSchema,
      bypassPermissions: z.boolean(),
    })
    .strict(),
  z.object({ ...jobOpenedBase, jobKind: z.literal('kb') }).strict(),
]);

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

export const jobExecutionRequestedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    input: z.union([z.string(), kbJobLaunchPayloadSchema]),
    action: z.enum(['exec', 'resume']),
    pool: z.enum(LAUNCH_POOLS),
    enqueueSequence: z.number().int().nonnegative().safe(),
    coralEnv: z.record(z.string()),
    createdAt: z.string().datetime(),
    backendNamespace: z.string().min(1),
    bundleHash: z.string().optional(),
    discussionRun: discussionRunDescriptorSchema.optional(),
    originatingClientMessageId: z.string().min(1).optional(),
  })
  .strict();

export type KbSourceImportJobRequest = z.infer<typeof kbSourceImportJobRequestSchema>;
export type JobConversationFacet = z.infer<typeof jobConversationFacetSchema>;
export type JobOpenedBody = z.infer<typeof jobOpenedBodySchema>;
export type JobExecutionRequestedBody = z.infer<typeof jobExecutionRequestedBodySchema>;
