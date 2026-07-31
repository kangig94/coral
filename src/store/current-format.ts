import { z } from 'zod';

import {
  describeStoreFormat,
  PersistedCodecRegistry,
  zodPersistedContract,
  type CanonicalContractValue,
  type PersistedDdlFragment,
  type StoreFormatFingerprintDescription,
} from './format-fingerprint.js';
import type { ComposedReducers } from './reducers.js';
import schemaSource from './schema.sql';

export type CurrentStoreCodecSchemas = Readonly<{
  eventEnvelope: z.ZodTypeAny;
  eventRefs: z.ZodTypeAny;
  jobPhase: z.ZodTypeAny;
  jobKind: z.ZodTypeAny;
  projectionJobRow: z.ZodTypeAny;
  jobTerminal: z.ZodTypeAny;
  jobDiagnostics: z.ZodTypeAny;
  executionOwner: z.ZodTypeAny;
  providerSession: z.ZodTypeAny;
  projectionSessionRow: z.ZodTypeAny;
  discussState: z.ZodTypeAny;
  workflowPlan: z.ZodTypeAny;
  providerScope: z.ZodTypeAny;
  workflowLifecycle: z.ZodTypeAny;
  expansionManifest: z.ZodTypeAny;
  consumerCursorMetadata: z.ZodTypeAny;
  journalConsumerCursor: z.ZodTypeAny;
  corpusConsumerCursor: z.ZodTypeAny;
  kbCurateActiveClaimRow: z.ZodTypeAny;
  kbCorpusStateRow: z.ZodTypeAny;
  kbCurateSchedulerRow: z.ZodTypeAny;
  kbCurateRetryRow: z.ZodTypeAny;
  kbCurateConflictQuarantineRow: z.ZodTypeAny;
  kbCurateDiscoveryBacklogRow: z.ZodTypeAny;
  kbCurateDiscoveryBacklogNoteRow: z.ZodTypeAny;
}>;

export type CurrentStoreCodecComponent = Readonly<{ name: string; contract: CanonicalContractValue }>;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

function registerEventBodyCodec(codecs: PersistedCodecRegistry, reducers: ComposedReducers): void {
  const events = [...reducers.schemas.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([type, schema]) => ({
      type,
      streamKind: reducers.streamKinds.get(type),
      contract: zodPersistedContract(schema),
      materializer: reducers.materializerContracts.get(type) ?? null,
    }));
  codecs.register('store.events.body', { kind: 'event-body-map', events });
  codecs.register(
    'store.events.append-validation',
    {
      kind: 'append-validator-contracts',
      validators: [...reducers.appendValidatorContracts].sort(),
    },
    'component',
  );
}

/**
 * Describe Coral's complete SQL-backed persisted contract. The store owns the
 * stable codec names; the application composition root supplies the domain
 * schemas without reversing the store-to-domain dependency direction.
 */
export function createCurrentStoreFormat(
  reducers: ComposedReducers,
  schemas: CurrentStoreCodecSchemas,
  ddlFragments: readonly PersistedDdlFragment[],
  components: readonly CurrentStoreCodecComponent[] = [],
): StoreFormatFingerprintDescription {
  const codecs = new PersistedCodecRegistry();
  registerEventBodyCodec(codecs, reducers);
  codecs.registerZodComponent('store.events.envelope', schemas.eventEnvelope);
  codecs.registerZod('store.events.refs', schemas.eventRefs);
  codecs.registerZodComponent('store.projection_jobs.phase', schemas.jobPhase);
  codecs.registerZodComponent('store.projection_jobs.job-kind', schemas.jobKind);
  codecs.registerZodComponent('store.projection_jobs.row', schemas.projectionJobRow);
  codecs.registerZod('store.projection_jobs.terminal', schemas.jobTerminal);
  codecs.registerZod('store.projection_jobs.diagnostics', schemas.jobDiagnostics);
  codecs.registerZod('store.projection_jobs.execution_owner', schemas.executionOwner);
  codecs.registerZod('store.projection_sessions.entry', schemas.providerSession);
  codecs.registerZodComponent('store.projection_sessions.row', schemas.projectionSessionRow);
  codecs.registerZod('store.projection_discuss.state', schemas.discussState);
  codecs.registerZod('store.projection_workflows.plan', schemas.workflowPlan);
  codecs.registerZod('store.projection_workflows.provider_scope', schemas.providerScope);
  codecs.registerZodComponent('workflow.lifecycle', schemas.workflowLifecycle);
  codecs.registerZod('store.kb_curate_retry_queue.signals', jsonValueSchema);
  codecs.registerZod('store.expansion_manifest_catalog.manifest', schemas.expansionManifest);
  codecs.registerZodComponent('store.consumer_cursors.metadata', schemas.consumerCursorMetadata);
  codecs.registerZodComponent('store.consumer_cursors.journal-cursor', schemas.journalConsumerCursor);
  codecs.registerZodComponent('store.consumer_cursors.corpus-cursor', schemas.corpusConsumerCursor);
  codecs.registerZodComponent('store.kb_curate_active_claim.row', schemas.kbCurateActiveClaimRow);
  codecs.registerZodComponent('store.kb_corpus_state.row', schemas.kbCorpusStateRow);
  codecs.registerZodComponent('store.kb_curate_scheduler.row', schemas.kbCurateSchedulerRow);
  codecs.registerZodComponent('store.kb_curate_retry_queue.row', schemas.kbCurateRetryRow);
  codecs.registerZodComponent('store.kb_curate_conflict_quarantine.row', schemas.kbCurateConflictQuarantineRow);
  codecs.registerZodComponent('store.kb_curate_discovery_backlog.row', schemas.kbCurateDiscoveryBacklogRow);
  codecs.registerZodComponent('store.kb_curate_discovery_backlog_notes.row', schemas.kbCurateDiscoveryBacklogNoteRow);
  for (const component of components) codecs.register(component.name, component.contract, 'component');
  return describeStoreFormat(schemaSource, codecs, ddlFragments);
}
