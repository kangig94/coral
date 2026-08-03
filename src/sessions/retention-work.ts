import { z } from 'zod';

import { causeRefSchema, type CauseRef } from '../causality/cause-ref.js';
import { providerArtifactIdentitySchema } from '../providers/artifact-identity.js';
import type { RecoveryObligationId, RecoverySettlementFact, RecoverySubject } from '../recovery/containment.js';
import type { RawRetentionWorkItem } from './retention-work-item-recovery-source.js';
import type { ProviderSession } from './entry.js';
import type { ProviderArtifactActionDescriptor } from './provider-artifact-archive.js';

export const RETENTION_PROVIDER_DISCARD_OBLIGATION = 'session.retention.provider-discard' as RecoveryObligationId;
export const RETENTION_ATTEMPT_OBLIGATION = 'session.retention.attempt' as RecoveryObligationId;
export const RETENTION_TERMINAL_OBLIGATION = 'session.retention.terminal' as RecoveryObligationId;
export const RETENTION_WORK_OBLIGATIONS = [
  RETENTION_PROVIDER_DISCARD_OBLIGATION,
  RETENTION_ATTEMPT_OBLIGATION,
  RETENTION_TERMINAL_OBLIGATION,
] as const;
export const RETENTION_DISCARD_CONTINUATION_KIND = 'retention-discard.v1';

const canonicalArtifactHandleSchema = z
  .object({
    handle: z.string().min(1),
    sourceJobId: z.string().min(1),
    identity: providerArtifactIdentitySchema.optional(),
  })
  .strict();

const artifactActionDescriptorSchema = z
  .object({
    operationId: z.string().min(1),
    sessionId: z.string().min(1),
    jobId: z.string().min(1),
    provider: z.string().min(1),
    sourceRevision: z.string().min(1),
    handles: z.array(canonicalArtifactHandleSchema),
    archiveActionId: z.string().min(1),
    archivePayloadHash: z.string().min(1),
    discardActionId: z.string().min(1),
    discardPayloadHash: z.string().min(1),
    archivedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const retentionObligationSchema = z.enum([
  RETENTION_PROVIDER_DISCARD_OBLIGATION,
  RETENTION_ATTEMPT_OBLIGATION,
  RETENTION_TERMINAL_OBLIGATION,
]);

const retentionDiscardContinuationSchema = z
  .object({
    v: z.literal(1),
    sessionId: z.string().min(1),
    jobId: z.string().min(1),
    sourceRevision: z.string().min(1),
    attempt: z.number().int().positive(),
    handles: z.array(z.string()),
    descriptor: artifactActionDescriptorSchema,
    terminalCauseRef: causeRefSchema.optional(),
    completedObligationIds: z.array(retentionObligationSchema),
    stage: z.enum(['prepared', 'requested', 'discard-pending', 'discard-applied']),
    observedOutcome: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('applied'), outcome: z.string().min(1) }).strict(),
        z.object({ kind: z.literal('definitive-failure'), reason: z.string() }).strict(),
      ])
      .optional(),
  })
  .strict();

type ParsedRetentionDiscardContinuation = z.infer<typeof retentionDiscardContinuationSchema>;

export type RetentionDiscardContinuation = Omit<
  ParsedRetentionDiscardContinuation,
  'handles' | 'descriptor' | 'completedObligationIds'
> & {
  readonly handles: readonly string[];
  readonly descriptor: ProviderArtifactActionDescriptor;
  readonly completedObligationIds: readonly RecoveryObligationId[];
};

export type RecoverySessionRetentionWork = SessionRetentionWork & {
  readonly recovery: {
    readonly subject: RecoverySubject;
    readonly sourceRevision: string;
    readonly terminalCauseRef: CauseRef;
    readonly archivedAt: string;
    readonly continuation: RetentionDiscardContinuation | null;
  };
};

export function retentionRecoveryFact(
  obligation: RecoveryObligationId,
  outcome: RecoverySettlementFact['outcome'],
  authorityRef?: string,
): RecoverySettlementFact {
  return {
    obligation,
    outcome,
    ...(authorityRef === undefined ? {} : { authorityRef }),
  };
}

/** Hydrates the composite continuation only after every nested component has been contained. */
export function hydrateRecoverySessionRetentionWork(raw: RawRetentionWorkItem): RecoverySessionRetentionWork {
  let continuation: RetentionDiscardContinuation | null = null;
  if (raw.continuation !== null) {
    if (
      raw.continuation.continuation_kind !== RETENTION_DISCARD_CONTINUATION_KIND ||
      raw.continuation.continuation_key === null
    ) {
      throw new TypeError(`Retention work '${raw.subject.key}' has an invalid continuation kind.`);
    }
    continuation = retentionDiscardContinuationSchema.parse(
      JSON.parse(raw.continuation.continuation_key) as unknown,
    ) as RetentionDiscardContinuation;
    if (continuation.sessionId !== raw.sessionId || continuation.jobId !== raw.jobId) {
      throw new TypeError(`Retention work '${raw.subject.key}' continuation names another subject.`);
    }
    if (new Set(continuation.completedObligationIds).size !== continuation.completedObligationIds.length) {
      throw new TypeError(`Retention work '${raw.subject.key}' continuation repeats an obligation.`);
    }
  }
  return {
    sessionId: raw.sessionId,
    jobId: raw.jobId,
    entry: raw.entry,
    recovery: {
      subject: raw.subject,
      sourceRevision: continuation?.sourceRevision ?? raw.sourceRevision,
      terminalCauseRef: { stream: { kind: 'job', id: raw.jobId }, seq: raw.terminal.row.seq },
      archivedAt: continuation?.descriptor.archivedAt ?? raw.terminal.row.ts,
      continuation,
    },
  };
}

export type SessionRetentionPair = {
  readonly sessionId: string;
  readonly jobId: string;
};

export type SessionRetentionWork = SessionRetentionPair & {
  readonly entry: ProviderSession;
};

export function sessionRetentionWorkKey(sessionId: string, jobId: string): string {
  return `${sessionId}\u0000${jobId}`;
}
