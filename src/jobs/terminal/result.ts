import { z } from 'zod';

import {
  jobProgressFaultSchema,
  terminalOutcomeSchema,
  type JobProgressFault,
  type TerminalOutcome,
} from '../outcome.js';
import { usageSummarySchema, type UsageSummary } from '../../providers/contract.js';
import { jobContinuitySnapshotSchema } from '../continuity.js';

export interface JobTerminal {
  content: string;
  outcome: TerminalOutcome;
  durationMs?: number;
}

export type JobTerminalInput = JobTerminal;

export interface JobTerminalDiagnostics {
  warnings?: string[];
  usage?: UsageSummary;
  processExit?: {
    exitCode: number | null;
    signal: string | null;
  };
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

export const jobTerminalDiagnosticsSchema = z
  .object({
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    processExit: z
      .object({
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const jobDiagnosticsSchema = jobTerminalDiagnosticsSchema
  .extend({
    progressFaults: z.array(jobProgressFaultSchema),
  })
  .strict();

export function normalizeJobTerminal(input: JobTerminalInput): JobTerminal {
  return {
    content: input.content,
    outcome: input.outcome,
    durationMs: input.durationMs ?? 0,
  };
}

export const jobTerminalRecordedBodySchema = z
  .object({
    terminal: jobTerminalSchema,
    diagnostics: jobTerminalDiagnosticsSchema.optional(),
    continuity: jobContinuitySnapshotSchema.nullable().optional(),
  })
  .strict();

export type JobTerminaledBody = z.infer<typeof jobTerminalRecordedBodySchema>;
