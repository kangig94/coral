import { z } from 'zod';

import { assertNever } from '../infra/error-format.js';

export const sessionInterruptTriggerSchema = z.enum(['restart', 'handoff']);

export const sessionContinuityStateSchema = z.enum([
  'verified',
  'missing',
  'unavailable',
  'pre_checkpoint_empty',
  'pre_checkpoint_preserved',
]);
export type SessionContinuityState = z.infer<typeof sessionContinuityStateSchema>;

export const sessionInterruptedFaultSchema = z
  .object({
    trigger: sessionInterruptTriggerSchema,
    continuity: sessionContinuityStateSchema,
  })
  .strict();
export type SessionInterruptedFault = z.infer<typeof sessionInterruptedFaultSchema>;

export const sessionProviderFailureReasonSchema = z.enum(['session_unavailable', 'request_failed']);
export type SessionProviderFailureReason = z.infer<typeof sessionProviderFailureReasonSchema>;

export const sessionProviderFailedFaultSchema = z
  .object({
    provider: z.string(),
    reason: sessionProviderFailureReasonSchema,
    message: z.string(),
  })
  .strict();
export type SessionProviderFailedFault = z.infer<typeof sessionProviderFailedFaultSchema>;

export const sessionAdapterUnparseableFaultSchema = z
  .object({
    provider: z.string(),
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    parseError: z.string(),
  })
  .strict();
export type SessionAdapterUnparseableFault = z.infer<typeof sessionAdapterUnparseableFaultSchema>;

export function continuitySentenceFragment(continuity: SessionContinuityState): string {
  switch (continuity) {
    case 'verified':
      return 'continuity verified';
    case 'missing':
      return 'continuity missing';
    case 'unavailable':
      return 'continuity unavailable';
    case 'pre_checkpoint_empty':
      return 'no resumable conversation was available';
    case 'pre_checkpoint_preserved':
      return 'existing conversation reference was preserved';
    default:
      return assertNever(continuity);
  }
}

export function describeSessionInterrupted(fault: SessionInterruptedFault): string {
  const triggerText =
    fault.trigger === 'restart'
      ? 'App-server restarted during the turn'
      : 'App-server handoff occurred during the turn';
  return `${triggerText}; ${continuitySentenceFragment(fault.continuity)}.`;
}
