import { z } from 'zod';

import { assertNever } from '../../infra/error-format.js';
import { turnFailureDiagnosticSchema } from '../../providers/turn-failure-diagnostic.js';

const sessionInterruptTriggerSchema = z.enum(['restart', 'handoff']);

const sessionContinuityStateSchema = z.enum([
  'verified',
  'missing',
  'unavailable',
  'pre_checkpoint_empty',
  'pre_checkpoint_preserved',
]);
export type SessionContinuityState = z.infer<typeof sessionContinuityStateSchema>;

export const conversationInterruptedFaultSchema = z
  .object({
    trigger: sessionInterruptTriggerSchema,
    continuity: sessionContinuityStateSchema,
  })
  .strict();
export type ConversationInterruptedFault = z.infer<typeof conversationInterruptedFaultSchema>;

const sessionProviderFailureReasonSchema = z.enum(['session_unavailable', 'request_failed']);

export const sessionProviderFailedFaultSchema = z
  .object({
    provider: z.string(),
    reason: sessionProviderFailureReasonSchema,
    message: z.string(),
    diagnostic: turnFailureDiagnosticSchema.optional(),
  })
  .strict();
export type SessionProviderFailedFault = z.infer<typeof sessionProviderFailedFaultSchema>;

export const sessionAdapterUnparseableFaultSchema = z
  .object({
    provider: z.string(),
    exitCode: z.number().finite().nullable(),
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

export function describeConversationInterrupted(fault: ConversationInterruptedFault): string {
  const triggerText =
    fault.trigger === 'restart'
      ? 'App-server restarted during the turn'
      : 'App-server handoff occurred during the turn';
  return `${triggerText}; ${continuitySentenceFragment(fault.continuity)}.`;
}
