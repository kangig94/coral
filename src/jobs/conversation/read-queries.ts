import { hashToken } from '../../infra/hash.js';
import type { Database } from '../../store/db.js';
import { decodeEventBody } from '../../store/body-codec.js';
import {
  readProjectionJobRow,
  readProjectionJobRows,
  decodeProjectionJobStoredRow,
  type ProjectionJobStoredRow,
} from '../projection-row.js';
import { jobConversationFacetSchema } from '../launch.js';
import { isTerminalPhase } from '../phase.js';
import {
  jobArtifactRecordedBodySchema,
  jobContinuityCheckpointedBodySchema,
  jobRetentionDiscardRequestedBodySchema,
  jobRetentionDiscardCompletedBodySchema,
  jobRetentionDiscardFailedBodySchema,
} from '../event-bodies.js';
import type { JobConversation, ProviderArtifactHandle, RetentionDiscardAttempt } from './entry.js';

export type ConversationEvidence = {
  readonly projection: ProjectionJobStoredRow;
  readonly events: readonly { seq: number; ts: string; type: string; body: Uint8Array }[];
};

export function readProjectionJobConversation(db: Database, jobId: string): JobConversation | null {
  const row = readProjectionJobRow(db, jobId);
  if (row?.job_kind !== 'provider' || row.facet === null) return null;
  const events = db
    .prepare<[string], { seq: number; ts: string; type: string; body: Uint8Array }>(
      `SELECT seq, ts, type, body FROM events WHERE stream_kind = 'job' AND stream_id = ?
      AND type IN ('job.continuity.checkpointed', 'job.artifact.recorded', 'job.retention.discard.requested',
        'job.retention.discard.completed', 'job.retention.discard.failed') ORDER BY seq`,
    )
    .all(jobId);
  return hydrateJobConversation({ projection: row, events });
}

export function hydrateJobConversation(evidence: ConversationEvidence): JobConversation {
  const row = decodeProjectionJobStoredRow(evidence.projection);
  if (row.job_kind !== 'provider' || row.facet === null)
    throw new TypeError('Conversation evidence must name a provider job.');
  const jobId = row.job_id;
  const events = evidence.events;
  const facet = jobConversationFacetSchema.parse(JSON.parse(row.facet));
  let providerContinuity: JobConversation['providerContinuity'] = null;
  const artifactHandles: ProviderArtifactHandle[] = [];
  const attempts = new Map<string, RetentionDiscardAttempt>();
  let lastUsedAt = row.created_at;
  for (const event of events) {
    const raw = decodeEventBody(event.body);
    lastUsedAt = event.ts;
    if (event.type === 'job.continuity.checkpointed') {
      providerContinuity = jobContinuityCheckpointedBodySchema.parse(raw).snapshot.providerContinuity;
    } else if (event.type === 'job.artifact.recorded') {
      const { provider: _provider, ...artifact } = jobArtifactRecordedBodySchema.parse(raw);
      artifactHandles.push({ ...artifact, sourceJobId: jobId, recordedAt: event.ts });
    } else if (
      event.type === 'job.retention.discard.requested' ||
      event.type === 'job.retention.discard.completed' ||
      event.type === 'job.retention.discard.failed'
    ) {
      const body =
        event.type === 'job.retention.discard.requested'
          ? jobRetentionDiscardRequestedBodySchema.parse(raw)
          : event.type === 'job.retention.discard.completed'
            ? jobRetentionDiscardCompletedBodySchema.parse(raw)
            : jobRetentionDiscardFailedBodySchema.parse(raw);
      const status =
        event.type === 'job.retention.discard.requested'
          ? 'requested'
          : event.type === 'job.retention.discard.completed'
            ? 'completed'
            : 'failed';
      attempts.set(`${body.execution}:${body.attempt}`, { ...body, status });
    }
  }
  return {
    ...facet,
    jobId,
    execution: row.execution ?? 0,
    open: row.execution !== null && !isTerminalPhase(row.phase),
    finishing: row.finishing === 1,
    ...(row.conversation_ref === null ? {} : { conversationRef: row.conversation_ref }),
    providerContinuity,
    artifactHandles,
    retentionDiscard: { attempts: [...attempts.values()] },
    projectRoot: row.project_root,
    backendNamespace: row.backend_namespace ?? '',
    createdAt: row.created_at,
    lastUsedAt,
  };
}

export function listProjectionConversationEntries(
  db: Database,
  provider?: string,
  scopeKey?: string,
  onInvalidRow?: (jobId: string | null, error: unknown, key: string) => void,
): JobConversation[] {
  const entries: JobConversation[] = [];
  for (const row of readProjectionJobRows(db)) {
    if (row.job_kind !== 'provider' || (provider !== undefined && row.provider !== provider)) continue;
    if (scopeKey !== undefined && hashToken(row.project_root, 12) !== scopeKey) continue;
    try {
      const entry = readProjectionJobConversation(db, row.job_id);
      if (entry !== null) entries.push(entry);
    } catch (error) {
      if (onInvalidRow === undefined) throw error;
      onInvalidRow(row.job_id, error, row.job_id);
    }
  }
  return entries;
}

export function readJobConversationById(db: Database, jobId: string): JobConversation {
  const entry = readProjectionJobConversation(db, jobId);

  if (entry === null) {
    throw new Error(`Provider job not found: ${jobId}`);
  }

  return entry;
}
