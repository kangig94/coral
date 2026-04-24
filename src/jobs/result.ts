import { z } from 'zod';

import {
  jobProgressFaultSchema,
  terminalOutcomeSchema,
  type JobProgressFault,
  type TerminalOutcome,
} from './outcome.js';
import { usageSummarySchema, type UsageSummary } from '../providers/contract.js';

export interface JobTerminal {
  content: string;
  outcome: TerminalOutcome;
  durationMs?: number;
}

export type JobTerminalInput = JobTerminal;

export interface JobTerminalDiagnostics {
  warnings?: string[];
  usage?: UsageSummary;
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
