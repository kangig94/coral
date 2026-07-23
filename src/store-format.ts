import { discussRegistry } from './discuss/event-registry.js';
import { persistedDiscussSnapshotSchema } from './discuss/projections.js';
import { declarativeEngineManifestSchema } from './expansion/manifest/schema.js';
import { providerScopeSchema } from './infra/provider-scope.js';
import { jobsRegistry } from './jobs/events.js';
import { jobPhaseSchema } from './jobs/phase.js';
import { jobKindSchema } from './jobs/records.js';
import { projectionJobDecoderContract, projectionJobStoredRowSchema } from './jobs/projection-row.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from './jobs/terminal/result.js';
import { corpusAuthorityBaselineDdl } from './kb/corpus/rescan/authority-baseline.js';
import { quarantineRowSchema } from './kb/curate/conflict-quarantine.js';
import { backlogNoteRowSchema, backlogRowSchema } from './kb/curate/discovery-backlog.js';
import { retryRowSchema } from './kb/curate/retry.js';
import { schedulerDecoderContract, schedulerRowSchema } from './kb/curate/state-scheduler.js';
import { activeClaimRowSchema } from './kb/curate/state/store.js';
import { corpusStateRowSchema } from './kb/state/corpus-state.js';
import { createBuiltInProviderRegistry } from './providers/bootstrap.js';
import type { ProviderRegistry } from './providers/registry.js';
import {
  consumerCursorMetadataSchema,
  corpusConsumerCursorSchema,
  journalConsumerCursorSchema,
} from './projection-consumers/persistence.js';
import { executionOwnerSchema } from './runtime/execution-owner.js';
import { providerSessionSchema } from './sessions/entry.js';
import { projectionSessionDecoderContract, projectionSessionStoredRowSchema } from './sessions/projections.js';
import { sessionsRegistry } from './sessions/events.js';
import { createCurrentStoreFormat } from './store/current-format.js';
import { journalEventEnvelopeSchema, journalEventRefsSchema } from './store/envelope.js';
import type { StoreFormatDescription } from './store/format-fingerprint.js';
import { composeReducers } from './store/reducers.js';
import { workflowRegistry } from './workflow/events.js';
import { workflowLifecycleSchema } from './workflow/lifecycle.js';
import { workflowPlanSchema } from './workflow/plan.js';

/** Describe the SQL contract contributed by one complete provider registry. */
export function describeCoralStoreFormat(providerRegistry: ProviderRegistry): StoreFormatDescription {
  return createCurrentStoreFormat(
    composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
    {
      eventEnvelope: journalEventEnvelopeSchema,
      eventRefs: journalEventRefsSchema,
      jobPhase: jobPhaseSchema,
      jobKind: jobKindSchema,
      projectionJobRow: projectionJobStoredRowSchema,
      jobTerminal: jobTerminalSchema,
      jobDiagnostics: jobDiagnosticsSchema,
      executionOwner: executionOwnerSchema,
      providerSession: providerSessionSchema,
      projectionSessionRow: projectionSessionStoredRowSchema,
      discussState: persistedDiscussSnapshotSchema,
      workflowPlan: workflowPlanSchema,
      providerScope: providerScopeSchema,
      workflowLifecycle: workflowLifecycleSchema,
      expansionManifest: declarativeEngineManifestSchema,
      consumerCursorMetadata: consumerCursorMetadataSchema,
      journalConsumerCursor: journalConsumerCursorSchema,
      corpusConsumerCursor: corpusConsumerCursorSchema,
      kbCurateActiveClaimRow: activeClaimRowSchema,
      kbCorpusStateRow: corpusStateRowSchema,
      kbCurateSchedulerRow: schedulerRowSchema,
      kbCurateRetryRow: retryRowSchema,
      kbCurateConflictQuarantineRow: quarantineRowSchema,
      kbCurateDiscoveryBacklogRow: backlogRowSchema,
      kbCurateDiscoveryBacklogNoteRow: backlogNoteRowSchema,
    },
    [corpusAuthorityBaselineDdl],
    [
      {
        name: 'store.external-format-marker',
        contract: { path: '<store.db>.format', encoding: 'utf-8', content: '<store-format-fingerprint>\\n' },
      },
      { name: 'store.projection_jobs.decoder-semantics', contract: projectionJobDecoderContract },
      { name: 'store.projection_sessions.decoder-semantics', contract: projectionSessionDecoderContract },
      { name: 'store.kb_curate_scheduler.decoder-semantics', contract: schedulerDecoderContract },
      ...providerRegistry.sealPersistedCodecComponents(),
    ],
  );
}

let builtInStoreFormat: StoreFormatDescription | undefined;

/** One immutable application-wide store format shared by every process that opens Coral state. */
export function currentCoralStoreFormat(): StoreFormatDescription {
  builtInStoreFormat ??= describeCoralStoreFormat(createBuiltInProviderRegistry());
  return builtInStoreFormat;
}

/**
 * Seal a runtime registry and prove it has exactly the codecs understood by
 * every independently launched Coral process before it may own the store.
 */
export function sealCoralStoreFormat(providerRegistry: ProviderRegistry): StoreFormatDescription {
  const registered = describeCoralStoreFormat(providerRegistry);
  const current = currentCoralStoreFormat();
  if (registered.canonicalManifest !== current.canonicalManifest) {
    throw new TypeError('Provider registry does not match the canonical Coral store format.');
  }
  return current;
}
