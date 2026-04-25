import { z } from 'zod';

import { causeRefSchema, type CauseRef } from '../causality/cause-ref.js';
import { assertNever } from '../infra/error-format.js';
import { ensureSentence } from '../infra/format-progress.js';

export const sessionInterruptTriggerSchema = z.enum(['restart', 'handoff']);
export type SessionInterruptTrigger = z.infer<typeof sessionInterruptTriggerSchema>;

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

export const sessionCloseReasonSchema = z.union([
  z.enum(['completed', 'non_resumable', 'interrupted']),
  z
    .object({
      kind: z.literal('failed'),
      causeRef: causeRefSchema,
    })
    .strict(),
]);
export type SessionCloseReason =
  | 'completed'
  | 'non_resumable'
  | 'interrupted'
  | { kind: 'failed'; causeRef: CauseRef };

export type SessionFault =
  | SessionInterruptedFault
  | SessionProviderFailedFault
  | SessionAdapterUnparseableFault;

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    default:
      return provider;
  }
}

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

export function describeSessionProviderFailed(fault: SessionProviderFailedFault): string {
  const provider = providerDisplayName(fault.provider);

  switch (fault.reason) {
    case 'session_unavailable':
      return `${provider} session unavailable: ${ensureSentence(fault.message)}`;
    case 'request_failed': {
      const message = fault.message.trim();
      if (!message) {
        return `${provider} turn failed.`;
      }
      if (message.toLowerCase().startsWith(provider.toLowerCase())) {
        return ensureSentence(message);
      }
      return `${provider} turn failed: ${ensureSentence(message)}`;
    }
    default:
      return assertNever(fault.reason);
  }
}

export function describeSessionAdapterUnparseable(fault: SessionAdapterUnparseableFault): string {
  const provider = providerDisplayName(fault.provider);
  const exit = fault.exitCode === null ? 'unknown' : String(fault.exitCode);
  return `${provider} produced unparseable output (exit ${exit}): ${fault.parseError}.`;
}
