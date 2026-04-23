import { z } from 'zod';

import {
  jobProgressFaultSchema,
  terminalOutcomeSchema,
  type JobProgressFault,
  type TerminalOutcome,
} from './outcome.js';
import { usageSummarySchema, type UsageSummary } from '../providers/contract.js';

export interface WorkflowStepMeta {
  agent: string;
  step: number;
  atom: number;
  provider: string;
  start: number;
  end: number;
}

export interface WorkflowResultMeta {
  steps: WorkflowStepMeta[];
}

const workflowStepMetaSchema = z
  .object({
    agent: z.string(),
    step: z.number(),
    atom: z.number(),
    provider: z.string(),
    start: z.number(),
    end: z.number(),
  })
  .strict();

export const workflowResultMetaSchema = z
  .object({
    steps: z.array(workflowStepMetaSchema),
  })
  .strict();

export interface JobTerminal {
  content: string;
  outcome: TerminalOutcome;
  durationMs?: number;
  exitCode?: number | null;
  warnings?: string[];
  usage?: UsageSummary;
  workflow?: WorkflowResultMeta;
}

export interface JobDiagnostics {
  progressFaults: JobProgressFault[];
}

export const jobTerminalSchema = z
  .object({
    content: z.string(),
    outcome: terminalOutcomeSchema,
    durationMs: z.number().optional(),
    exitCode: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    workflow: workflowResultMetaSchema.optional(),
  })
  .strict();

export const jobDiagnosticsSchema = z
  .object({
    progressFaults: z.array(jobProgressFaultSchema),
  })
  .strict();
