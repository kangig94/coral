import { z } from 'zod';

import { causeRefSchema, type CauseRef } from '../jobs/outcome.js';

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
