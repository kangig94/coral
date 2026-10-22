import { z } from 'zod';

import { executionOrdinalSchema } from '../launch.js';
import type { ResolvableCauseRef } from '../../causality/cause-ref.js';

import {
  executionCauseRefSchema,
  executionOutcomeSchema,
  jobProgressFaultSchema,
  terminalOutcomeSchema,
} from '../outcome.js';
import { usageSummarySchema } from '../../providers/contract.js';
import type { JobTerminal, JobTerminalDiagnostics, JobTerminalInput } from '../records.js';

export const jobTerminalSchema = z
  .object({
    content: z.string(),
    outcome: terminalOutcomeSchema,
    durationMs: z.number().nonnegative(),
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
    byteCounts: z
      .object({
        stdout: z.number(),
        stderr: z.number(),
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
    durationMs: input.durationMs,
  };
}

export const jobExecutionOutcomeAcceptedBodySchema = z
  .object({
    execution: executionOrdinalSchema,
    terminal: jobTerminalSchema.extend({ outcome: executionOutcomeSchema }),
    diagnostics: jobTerminalDiagnosticsSchema.optional(),
  })
  .strict();

export const jobExecutionEndedBodySchema = z
  .object({ execution: executionOrdinalSchema, causeRef: executionCauseRefSchema })
  .strict();

export type JobExecutionOutcomeAcceptedBody = z.infer<typeof jobExecutionOutcomeAcceptedBodySchema>;
export type JobExecutionEndedBody = z.infer<typeof jobExecutionEndedBodySchema>;

export interface JobExecutionOutcomeAcceptedInputBody<Scope = never> {
  execution: number;
  terminal: JobTerminalInput<Scope>;
  diagnostics?: JobTerminalDiagnostics;
}

export interface JobExecutionEndedInputBody<Scope = never> {
  execution: number;
  causeRef: ResolvableCauseRef<Scope>;
}
