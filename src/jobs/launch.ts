import { z } from 'zod';
import type { ProviderBindingFailureCode } from '../providers/contracts/binding.js';
import type { JobSendTarget } from './send-target.js';

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

export type LaunchRefusalCode =
  | ProviderBindingFailureCode
  | 'unknown_provider'
  | 'invalid_agent'
  | 'agent_not_found'
  | 'agent_namespace_not_found'
  | 'invalid_request'
  | 'job_launch_duplicate'
  | 'job_owner_mismatch'
  | 'job_owner_missing'
  | 'job_provider_session_missing'
  | 'job_binding_owner_mismatch'
  | 'discussion_job_launch_conflict'
  | 'workflow_owner_terminal'
  | 'workflow_slot_job_conflict'
  | 'workflow_slot_job_mismatch'
  | 'provider_scope_missing'
  | 'provider_execution_environment_invalid'
  | 'provider_preflight_failed'
  | 'session_not_found'
  | 'non_resumable'
  | 'session_busy'
  | 'retention_discard_in_flight'
  | 'work_directory_missing'
  | 'continuation_target_changed'
  | 'execution_admission_in_flight'
  | 'execution_finishing'
  | 'execution_superseded'
  | 'profile_mismatch'
  | 'native_unobservable'
  | 'archive_missing'
  | 'archive_stale'
  | 'archive_invalid'
  | 'archive_hash_mismatch'
  | 'publication_failed'
  | 'busy'
  | 'succession_admission_paused'
  | 'transport_unsupported'
  | 'scope_mismatch'
  | 'provider_mismatch'
  | 'launch_failed';

export type LaunchUndeterminedCode =
  | 'work_directory_unobservable'
  | 'provider_preflight_undetermined'
  | 'discuss_launch_undetermined'
  | 'continuation_commit_uncertain';

export type RefusedLaunchDecision = {
  status: 'refused';
  code: LaunchRefusalCode;
  message: string;
};

export type UndeterminedLaunchDecision = {
  status: 'undetermined';
  code: LaunchUndeterminedCode;
  message: string;
};

export type ProviderJobLaunchDecision =
  | AcceptedProviderJobLaunchDecision
  | RefusedLaunchDecision
  | UndeterminedLaunchDecision;
export type WorkflowLaunchDecision = AcceptedWorkflowLaunchDecision | RefusedLaunchDecision;
export type LaunchDecision = ProviderJobLaunchDecision | AcceptedWorkflowLaunchDecision;

export const executionOrdinalSchema = z.number().int().positive().safe();

const acceptedLaunchFields = {
  jobId: z.string().min(1),
  execution: executionOrdinalSchema.optional(),
  requestedSeq: z.number().int().positive().safe(),
  epochKey: z.string().min(1),
  launchState: z.enum(['running', 'queued']),
};

export const acceptedLaunchResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...acceptedLaunchFields, kind: z.literal('provider-session') }).strict(),
  z.object({ ...acceptedLaunchFields, kind: z.literal('workflow'), workflowId: z.string().min(1) }).strict(),
]);

export type AcceptedLaunchResponse = z.infer<typeof acceptedLaunchResponseSchema>;

export function refuseLaunch(code: LaunchRefusalCode, message: string): RefusedLaunchDecision {
  return {
    status: 'refused',
    code,
    message,
  };
}

export function undeterminedLaunch(code: LaunchUndeterminedCode, message: string): UndeterminedLaunchDecision {
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
  continuationTarget?: JobSendTarget;
}

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
