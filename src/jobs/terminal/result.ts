import { z } from 'zod';

import {
  jobProgressFaultSchema,
  terminalOutcomeSchema,
  type JobProgressFault,
  type TerminalOutcome,
  type TerminalOutcomeInput,
} from '../outcome.js';
import { usageSummarySchema, type UsageSummary } from '../../providers/contract.js';
import { jobContinuitySnapshotSchema, type JobContinuitySnapshot } from '../continuity.js';

export interface JobTerminal {
  content: string;
  outcome: TerminalOutcome;
  durationMs?: number;
}

export interface JobTerminalInput<Scope = never> {
  content: string;
  outcome: TerminalOutcomeInput<Scope>;
  durationMs?: number;
}

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

export function normalizeJobTerminal(input: JobTerminal): JobTerminal;
export function normalizeJobTerminal<Scope>(input: JobTerminalInput<Scope>): JobTerminalInput<Scope>;
export function normalizeJobTerminal<Scope>(input: JobTerminalInput<Scope>): JobTerminalInput<Scope> {
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

export interface JobTerminalRecordedInputBody<Scope = never> {
  terminal: JobTerminalInput<Scope>;
  diagnostics?: JobTerminalDiagnostics;
  continuity?: JobContinuitySnapshot | null;
}
