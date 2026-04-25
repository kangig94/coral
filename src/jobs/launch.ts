import { z } from 'zod';

import type { EffortLevel, ProviderAction, ProviderInstruction } from '../providers/contract.js';

export type LaunchPool = 'default' | 'discuss' | 'curate';
export const sourceImportReadinessValues = ['commit', 'base-search', 'active-vector', 'all-equipped'] as const;
export const sourceImportReadinessSchema = z.enum(sourceImportReadinessValues);
export type SourceImportReadiness = z.infer<typeof sourceImportReadinessSchema>;

export type LaunchDecision =
  | { status: 'running'; job: string; session: string }
  | { status: 'queued'; job: string; session: string; message?: undefined }
  | { status: 'rejected'; phase: 'preflight'; code: string; message: string };

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
  parentWorkflowJobId?: string;
  agent?: string;
  pool?: LaunchPool;
}

export interface JobResumeRequest extends JobLaunchRequest {
  sessionId: string;
  provider?: string;
}

export interface JobForkRequest extends Omit<JobLaunchRequest, 'prompt' | 'agent' | 'pool'> {
  sessionId: string;
  provider?: string;
  prompt?: string;
}

export interface ProviderJobLaunchRequestBody {
  sessionId: string;
  provider: string;
  providerAction: ProviderAction;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: 'provider' | 'workflow';
  pool: string;
  enqueueSequence: number;
  request: {
    prompt: string;
    name?: string;
    model?: string;
    cwd: string;
    effort?: EffortLevel;
    bypassPermissions: boolean;
    systemPrompt?: string;
    conversationRef?: string;
    instruction?: ProviderInstruction;
    coralEnv: Record<string, string>;
  };
  createdAt: string;
}

export interface KbSourceImportJobLaunchRequestBody {
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: 'kb';
  pool: string;
  enqueueSequence: number;
  operation: 'kb.source_import';
  request: {
    filePath: string;
    slug?: string;
    readiness: SourceImportReadiness;
  };
  createdAt: string;
}

export type JobLaunchRequestBody = ProviderJobLaunchRequestBody | KbSourceImportJobLaunchRequestBody;

export const providerInstructionSchema = z
  .object({
    content: z.string(),
    channel: z.enum(['prompt', 'system']),
  })
  .strict();

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
        coralEnv: z.record(z.string()),
      })
      .strict(),
    createdAt: z.string(),
  })
  .strict();

export const kbSourceImportJobLaunchRequestBodySchema = z
  .object({
    projectRoot: z.string(),
    backendNamespace: z.string(),
    bundleHash: z.string().optional(),
    jobKind: z.literal('kb'),
    pool: z.string(),
    enqueueSequence: z.number().int().nonnegative(),
    operation: z.literal('kb.source_import'),
    request: z
      .object({
        filePath: z.string().min(1),
        slug: z.string().optional(),
        readiness: sourceImportReadinessSchema,
      })
      .strict(),
    createdAt: z.string(),
  })
  .strict();

export const jobLaunchRequestBodySchema = z.discriminatedUnion('jobKind', [
  providerJobLaunchRequestBodySchema,
  kbSourceImportJobLaunchRequestBodySchema,
]);
