import { z } from 'zod';

import {
  jobProgressFaultSchema,
  terminalOutcomeSchema,
  type JobProgressFault,
  type TerminalOutcome,
} from './outcome.js';

export interface JobTerminal {
  outcome: TerminalOutcome;
  durationMs: number;
}

export interface JobDiagnostics {
  progressFaults: JobProgressFault[];
}

export const jobTerminalSchema = z
  .object({
    outcome: terminalOutcomeSchema,
    durationMs: z.number(),
  })
  .strict();

export const jobDiagnosticsSchema = z
  .object({
    progressFaults: z.array(jobProgressFaultSchema),
  })
  .strict();
