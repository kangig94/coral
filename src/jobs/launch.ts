import { z } from 'zod';

import type { LaunchPool } from '../coordinator/live/admission.js';
import type { EffortLevel, ProviderAction, ProviderInstruction } from '../providers/protocol.js';

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

export interface JobLaunchRequestBody {
  sessionId: string;
  provider: string;
  providerAction: ProviderAction;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: 'provider' | 'workflow';
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
  parentJobId?: string;
  workflowSlot?: string;
  createdAt: string;
}

export const providerInstructionSchema = z
  .object({
    content: z.string(),
    channel: z.enum(['prompt', 'system']),
  })
  .strict();

export const jobLaunchRequestBodySchema = z
  .object({
    sessionId: z.string(),
    provider: z.string(),
    providerAction: z.enum(['exec', 'resume', 'fork']),
    projectRoot: z.string(),
    backendNamespace: z.string(),
    bundleHash: z.string().optional(),
    jobKind: z.enum(['provider', 'workflow']).optional(),
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
    parentJobId: z.string().optional(),
    workflowSlot: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();
