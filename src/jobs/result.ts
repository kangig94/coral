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
}

export type JobTerminalInput = JobTerminal;

export interface JobTerminalDiagnostics {
  warnings?: string[];
  usage?: UsageSummary;
  workflow?: WorkflowResultMeta;
}

export interface JobDiagnostics extends JobTerminalDiagnostics {
  progressFaults: JobProgressFault[];
}

export const jobTerminalSchema = z
  .object({
    content: z.string(),
    outcome: terminalOutcomeSchema,
    durationMs: z.number().default(0),
  })
  .strict();

export const jobDiagnosticsSchema = z
  .object({
    progressFaults: z.array(jobProgressFaultSchema),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    workflow: workflowResultMetaSchema.optional(),
  })
  .strict();

export function normalizeJobTerminal(input: JobTerminalInput): JobTerminal {
  return {
    content: input.content,
    outcome: input.outcome,
    durationMs: input.durationMs ?? 0,
  };
}

export function cloneJobTerminal(input: JobTerminal): JobTerminal {
  return {
    content: input.content,
    outcome: input.outcome,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}
