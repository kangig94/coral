import { z } from 'zod';

import { type ProviderTurnOutcomeCompat, legacyTerminalOutcomeSchema } from '../shared/legacy-terminal-outcome-compat.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderTurnProgressEvent {
  jobId: string;
  message: string;
  ts: string;
}

export type ProviderAction = 'exec' | 'resume' | 'fork';

export interface ProviderInstruction {
  content: string;
  channel: 'prompt' | 'system';
}

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export const usageSummarySchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  })
  .strict();

export interface ProviderRequest {
  action: ProviderAction;
  sessionId: string;
  name?: string;
  conversationRef?: string;
  prompt: string;
  model?: string;
  cwd: string;
  effort?: EffortLevel;
  bypassPermissions: boolean;
  systemPrompt?: string;
  coralEnv: Record<string, string>;
  instruction?: ProviderInstruction;
}

export interface ProviderTurnResult {
  content: string;
  conversationRef?: string;
  model?: string;
  durationMs?: number;
  nonResumable?: boolean;
  exitCode?: number | null;
  warnings?: string[];
  usage?: UsageSummary;
  outcome: ProviderTurnOutcomeCompat;
}

export const providerResultSchema = z
  .object({
    content: z.string(),
    conversationRef: z.string().optional(),
    model: z.string().optional(),
    durationMs: z.number().optional(),
    nonResumable: z.boolean().optional(),
    exitCode: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    outcome: legacyTerminalOutcomeSchema,
  })
  .strict();
