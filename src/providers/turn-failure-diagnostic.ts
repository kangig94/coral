import { z } from 'zod';

export const turnFailureDiagnosticReasonSchema = z.enum([
  'silent-hang',
  'api-error',
  'child-exit',
  'finalization-failure',
  'interrupted',
  'internal-error',
]);
export type TurnFailureDiagnosticReason = z.infer<typeof turnFailureDiagnosticReasonSchema>;

export const turnFailureDiagnosticPhaseSchema = z.enum(['sent', 'registered', 'responding', 'ending', 'terminal']);
export type TurnFailureDiagnosticPhase = z.infer<typeof turnFailureDiagnosticPhaseSchema>;

export const turnFailureDiagnosticSchema = z
  .object({
    reason: turnFailureDiagnosticReasonSchema,
    phase: turnFailureDiagnosticPhaseSchema,
    idleMs: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    childOutputTail: z.string(),
    transcriptTail: z.string(),
    sessionId: z.string().min(1).nullable(),
    conversationRef: z.string().min(1).nullable(),
  })
  .strict();
export type TurnFailureDiagnostic = z.infer<typeof turnFailureDiagnosticSchema>;
