import { z } from 'zod';

export const shutdownObligationSubjects = [
  'recovery-coordinator-teardown',
  'kb-child-shutdown',
  'provider-operation-mutation-drain',
  'provider-host-shutdown',
  'child-termination',
  'app-server-handoff-quiesce',
  'provider-host-drain-for-handoff',
  'process-incarnation-probe-shutdown',
  'lifecycle-reactor-dispose',
  'provider-control-and-ipc-authority-release',
] as const;

export const shutdownObligationSubjectSchema = z.enum(shutdownObligationSubjects);
export type ShutdownObligationSubject = z.infer<typeof shutdownObligationSubjectSchema>;

export const shutdownObligationAbandonMethod = 'coordinator.shutdown_obligation.abandon' as const;

export const shutdownObligationAbandonRequestSchema = z.object({ subject: shutdownObligationSubjectSchema }).strict();
export type ShutdownObligationAbandonRequest = z.infer<typeof shutdownObligationAbandonRequestSchema>;

export const shutdownObligationAbandonmentReceiptSchema = z
  .object({
    subject: shutdownObligationSubjectSchema,
    instanceId: z.string().min(1),
    recordedAt: z.string().datetime(),
    disposition: z.literal('abandoned-unconfirmed'),
    detail: z.string().min(1),
    statusPath: z.string().min(1),
  })
  .strict();
export type ShutdownObligationAbandonmentReceipt = z.infer<typeof shutdownObligationAbandonmentReceiptSchema>;

export const shutdownObligationAbandonResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), receipt: shutdownObligationAbandonmentReceiptSchema }).strict(),
  z.object({ kind: z.literal('not-held'), subject: shutdownObligationSubjectSchema }).strict(),
  z.object({ kind: z.literal('not-offered'), subject: shutdownObligationSubjectSchema }).strict(),
  z
    .object({
      kind: z.literal('status-write-refused'),
      subject: shutdownObligationSubjectSchema,
      detail: z.string().min(1),
    })
    .strict(),
]);
export type ShutdownObligationAbandonResult = z.infer<typeof shutdownObligationAbandonResultSchema>;
