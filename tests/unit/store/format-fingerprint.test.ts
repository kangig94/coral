import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { persistedDiscussSnapshotSchema } from '#src/discuss/projections.js';
import { declarativeEngineManifestSchema } from '#src/expansion/manifest/schema.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { jobPhaseSchema } from '#src/jobs/phase.js';
import { jobKindSchema } from '#src/jobs/records.js';
import { projectionJobStoredRowSchema } from '#src/jobs/projection-row.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from '#src/jobs/terminal/result.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { providerSessionSchema } from '#src/sessions/entry.js';
import { projectionSessionStoredRowSchema } from '#src/sessions/projections.js';
import { executionOwnerSchema } from '#src/runtime/execution-owner.js';
import { providerScopeSchema } from '#src/infra/provider-scope.js';
import { createCurrentStoreFormat } from '#src/store/current-format.js';
import { journalEventEnvelopeSchema, journalEventRefsSchema } from '#src/store/envelope.js';
import {
  compareStoreFormatFingerprint,
  describeStoreFormat,
  persistedCodecNamesFromDdl,
  PersistedCodecRegistry,
} from '#src/store/format-fingerprint.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { workflowLifecycleSchema } from '#src/workflow/lifecycle.js';
import { workflowPlanSchema } from '#src/workflow/plan.js';
import { corpusAuthorityBaselineDdl } from '#src/kb/corpus/rescan/authority-baseline.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { currentCoralStoreFormat, sealCoralStoreFormat } from '#src/store-format.js';
import { schedulerRowSchema } from '#src/kb/curate/state-scheduler.js';
import { retryRowSchema } from '#src/kb/curate/retry.js';
import { quarantineRowSchema } from '#src/kb/curate/conflict-quarantine.js';
import { backlogNoteRowSchema, backlogRowSchema } from '#src/kb/curate/discovery-backlog.js';
import { activeClaimRowSchema } from '#src/kb/curate/state/store.js';
import { corpusStateRowSchema } from '#src/kb/state/corpus-state.js';
import {
  consumerCursorMetadataSchema,
  corpusConsumerCursorSchema,
  journalConsumerCursorSchema,
} from '#src/projection-consumers/persistence.js';

const CURRENT_CORAL_STORE_FORMAT_FINGERPRINT =
  'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';

const CURRENT_BOUNDARY_CODEC_NAMES = [
  'store.events.body',
  'store.events.refs',
  'store.expansion_manifest_catalog.manifest',
  'store.kb_curate_retry_queue.signals',
  'store.projection_discuss.state',
  'store.projection_jobs.diagnostics',
  'store.projection_jobs.execution_owner',
  'store.projection_jobs.terminal',
  'store.projection_sessions.entry',
  'store.projection_workflows.plan',
  'store.projection_workflows.provider_scope',
] as const;

const CURRENT_COMPONENT_CODEC_NAMES = [
  'provider.binding-envelope',
  'provider.claude.binding',
  'provider.claude.continuity',
  'provider.claude.profile',
  'provider.codex.binding',
  'provider.codex.continuity',
  'provider.codex.profile',
  'store.events.append-validation',
  'store.events.envelope',
  'store.consumer_cursors.corpus-cursor',
  'store.consumer_cursors.journal-cursor',
  'store.consumer_cursors.metadata',
  'store.kb_curate_active_claim.row',
  'store.kb_curate_conflict_quarantine.row',
  'store.kb_curate_discovery_backlog.row',
  'store.kb_curate_discovery_backlog_notes.row',
  'store.kb_curate_retry_queue.row',
  'store.kb_curate_scheduler.row',
  'store.kb_corpus_state.row',
  'store.external-format-marker',
  'store.kb_curate_scheduler.decoder-semantics',
  'store.projection_jobs.decoder-semantics',
  'store.projection_jobs.job-kind',
  'store.projection_jobs.phase',
  'store.projection_jobs.row',
  'store.projection_sessions.row',
  'store.projection_sessions.decoder-semantics',
  'workflow.lifecycle',
] as const;

function ddlFor(...codecNames: readonly string[]): string {
  return codecNames.map((name, index) => `value_${index} TEXT -- JSON @persisted-codec ${name}`).join('\n');
}

const currentCodecSchemas = {
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
};

describe('StoreFormatFingerprint', () => {
  it('rejects a provider registry that independent Coral processes cannot decode', () => {
    expect(() => sealCoralStoreFormat(new ProviderRegistry())).toThrow(
      'Provider registry does not match the canonical Coral store format',
    );
  });

  it('describes every current persisted JSON boundary and every Journal event codec', () => {
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const format = currentCoralStoreFormat();

    expect(format.fingerprint).toBe(CURRENT_CORAL_STORE_FORMAT_FINGERPRINT);
    expect(format.manifest.codecs.map((entry) => entry.name)).toEqual(
      [...CURRENT_BOUNDARY_CODEC_NAMES, ...CURRENT_COMPONENT_CODEC_NAMES].sort(),
    );
    expect(persistedCodecNamesFromDdl(format.manifest.ddl)).toEqual(CURRENT_BOUNDARY_CODEC_NAMES);
    expect(format.manifest.ddl).toContain('-- @persisted-ddl kb.corpus.authority-baseline');
    expect(format.manifest.ddl).toContain('CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline_records');

    const eventCodec = format.manifest.codecs.find((entry) => entry.name === 'store.events.body');
    const eventContract = eventCodec?.contract as
      | { events?: readonly { type?: unknown; streamKind?: unknown }[] }
      | undefined;
    expect(eventContract?.events?.map((entry) => entry.type)).toEqual([...reducers.schemas.keys()].sort());
    expect(eventContract?.events?.every((entry) => typeof entry.streamKind === 'string')).toBe(true);
  });

  it('changes when an event type moves to another canonical stream without changing its body', () => {
    const currentReducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const movedReducers = composeReducers(
      { ...jobsRegistry, streamKind: 'session' },
      sessionsRegistry,
      discussRegistry,
      workflowRegistry,
    );

    expect(
      createCurrentStoreFormat(currentReducers, currentCodecSchemas, [corpusAuthorityBaselineDdl]).fingerprint,
    ).not.toBe(createCurrentStoreFormat(movedReducers, currentCodecSchemas, [corpusAuthorityBaselineDdl]).fingerprint);
  });

  it('changes when only an event materializer semantic contract changes', () => {
    const currentReducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const [first, ...rest] = jobsRegistry.entries;
    if (first === undefined) throw new Error('jobs registry is empty');
    if (first.reducer === undefined) throw new Error('first jobs registry entry has no materializer');
    const changedReducers = composeReducers(
      {
        ...jobsRegistry,
        entries: [{ ...first, materializerContract: `${first.materializerContract}:changed` }, ...rest],
      },
      sessionsRegistry,
      discussRegistry,
      workflowRegistry,
    );

    expect(
      createCurrentStoreFormat(currentReducers, currentCodecSchemas, [corpusAuthorityBaselineDdl]).fingerprint,
    ).not.toBe(
      createCurrentStoreFormat(changedReducers, currentCodecSchemas, [corpusAuthorityBaselineDdl]).fingerprint,
    );
  });

  it.each(['provider.codex.profile', 'provider.codex.continuity'] as const)(
    'changes when the provider-private %s contract changes',
    (componentName) => {
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const components = createBuiltInProviderRegistry().sealPersistedCodecComponents();
      const changedComponents = components.map((component) =>
        component.name === componentName
          ? { ...component, contract: { kind: 'intentionally-changed-provider-contract' } }
          : component,
      );

      const current = createCurrentStoreFormat(reducers, currentCodecSchemas, [corpusAuthorityBaselineDdl], components);
      const changed = createCurrentStoreFormat(
        reducers,
        currentCodecSchemas,
        [corpusAuthorityBaselineDdl],
        changedComponents,
      );

      expect(changed.fingerprint).not.toBe(current.fingerprint);
    },
  );

  it('is independent of codec registration order', () => {
    const left = new PersistedCodecRegistry();
    left.registerZod('store.alpha', z.object({ value: z.string() }).strict());
    left.registerZod('store.beta', z.array(z.number().int()));

    const right = new PersistedCodecRegistry();
    right.registerZod('store.beta', z.array(z.number().int()));
    right.registerZod('store.alpha', z.object({ value: z.string() }).strict());

    const ddl = ddlFor('store.alpha', 'store.beta');
    expect(describeStoreFormat(ddl, left).fingerprint).toBe(describeStoreFormat(ddl, right).fingerprint);
  });

  it('changes when a registered structural codec contract changes', () => {
    const before = new PersistedCodecRegistry();
    before.registerZod('store.value', z.object({ value: z.string().min(1) }).strict());

    const after = new PersistedCodecRegistry();
    after.registerZod('store.value', z.object({ value: z.number().int() }).strict());

    const ddl = ddlFor('store.value');
    expect(describeStoreFormat(ddl, before).fingerprint).not.toBe(describeStoreFormat(ddl, after).fingerprint);
  });

  it('fingerprints the scalar workflow lifecycle codec explicitly', () => {
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const current = createCurrentStoreFormat(reducers, currentCodecSchemas, [corpusAuthorityBaselineDdl]);
    const changed = createCurrentStoreFormat(
      reducers,
      {
        ...currentCodecSchemas,
        workflowLifecycle: z.enum(['active', 'completed']),
      },
      [corpusAuthorityBaselineDdl],
    );

    expect(current.manifest.codecs).toContainEqual(
      expect.objectContaining({ name: 'workflow.lifecycle', persistence: 'component' }),
    );
    expect(changed.fingerprint).not.toBe(current.fingerprint);
  });

  it('includes nested persisted codec components without treating them as SQL boundaries', () => {
    const first = new PersistedCodecRegistry();
    first.registerZodComponent('provider.fixture.binding', z.object({ profile: z.string() }).strict());
    const second = new PersistedCodecRegistry();
    second.registerZodComponent('provider.fixture.binding', z.object({ profile: z.number() }).strict());

    expect(describeStoreFormat('', first).fingerprint).not.toBe(describeStoreFormat('', second).fingerprint);
    expect(describeStoreFormat('', first).manifest.codecs).toEqual([
      expect.objectContaining({ name: 'provider.fixture.binding', persistence: 'component' }),
    ]);
  });

  it('requires and fingerprints stable identities for semantic effects', () => {
    const unlabelled = new PersistedCodecRegistry();
    expect(() =>
      unlabelled.registerZod(
        'store.value',
        z.string().transform((value) => value.trim()),
      ),
    ).toThrow('ZodEffects in a persisted contract requires a stable semantic identity');

    const before = new PersistedCodecRegistry();
    before.registerZod(
      'store.value',
      z
        .string()
        .transform((value) => value.trim())
        .describe('trim-surrounding-whitespace'),
    );
    const after = new PersistedCodecRegistry();
    after.registerZod(
      'store.value',
      z
        .string()
        .transform((value) => value.toLowerCase())
        .describe('normalize-lowercase'),
    );

    const ddl = ddlFor('store.value');
    expect(describeStoreFormat(ddl, before).fingerprint).not.toBe(describeStoreFormat(ddl, after).fingerprint);

    const unlabelledCatch = new PersistedCodecRegistry();
    expect(() => unlabelledCatch.registerZod('store.value', z.string().catch('fallback'))).toThrow(
      'ZodCatch in a persisted contract requires a stable semantic identity',
    );

    const firstCatch = new PersistedCodecRegistry();
    firstCatch.registerZod('store.value', z.string().catch('fallback').describe('fallback-empty-source'));
    const secondCatch = new PersistedCodecRegistry();
    secondCatch.registerZod('store.value', z.string().catch('fallback').describe('fallback-invalid-source'));
    expect(describeStoreFormat(ddl, firstCatch).fingerprint).not.toBe(
      describeStoreFormat(ddl, secondCatch).fingerprint,
    );
  });

  it('changes when a default or DDL contract changes', () => {
    const first = new PersistedCodecRegistry();
    first.registerZod('store.value', z.object({ value: z.string().default('first') }).strict());
    const second = new PersistedCodecRegistry();
    second.registerZod('store.value', z.object({ value: z.string().default('second') }).strict());

    const ddl = ddlFor('store.value');
    expect(describeStoreFormat(ddl, first).fingerprint).not.toBe(describeStoreFormat(ddl, second).fingerprint);

    const sameCodec = new PersistedCodecRegistry();
    sameCodec.registerZod('store.value', z.object({ value: z.string().default('first') }).strict());
    expect(describeStoreFormat(`${ddl}\n-- changed DDL`, sameCodec).fingerprint).not.toBe(
      describeStoreFormat(ddl, first).fingerprint,
    );
  });

  it('rejects duplicate names and invalid stable names', () => {
    const codecs = new PersistedCodecRegistry();
    codecs.register('store.value', { kind: 'json' });
    expect(() => codecs.register('store.value', { kind: 'json' })).toThrow(
      "Persisted codec 'store.value' is registered twice",
    );
    expect(() => codecs.register('Store Value', { kind: 'json' })).toThrow(
      "Invalid persisted codec name 'Store Value'",
    );
  });

  it('rejects missing registrations, orphan registrations, and duplicate DDL declarations', () => {
    const missing = new PersistedCodecRegistry();
    expect(() => describeStoreFormat(ddlFor('store.value'), missing)).toThrow(
      'Persisted codec coverage mismatch: missing=[store.value] orphaned=[]',
    );

    const orphaned = new PersistedCodecRegistry();
    orphaned.register('store.value', { kind: 'json' });
    expect(() => describeStoreFormat('', orphaned)).toThrow(
      'Persisted codec coverage mismatch: missing=[] orphaned=[store.value]',
    );

    expect(() => persistedCodecNamesFromDdl(ddlFor('store.value', 'store.value'))).toThrow(
      "DDL declares persisted codec 'store.value' more than once",
    );
  });

  it('rejects JSON columns without codec declarations and codec declarations on non-JSON columns', () => {
    expect(() => persistedCodecNamesFromDdl('payload TEXT -- JSON payload')).toThrow(
      'DDL JSON boundary on line 1 has no @persisted-codec declaration',
    );
    expect(() => persistedCodecNamesFromDdl('payload TEXT -- @persisted-codec store.value')).toThrow(
      'DDL persisted codec on line 1 is not declared as a JSON boundary',
    );
  });

  it('classifies the persisted fingerprint for startup reset authority', () => {
    const current = 'sha256:current';
    expect(compareStoreFormatFingerprint(null, current)).toEqual({ kind: 'missing', current });
    expect(compareStoreFormatFingerprint(current, current)).toEqual({ kind: 'current', current, stored: current });
    expect(compareStoreFormatFingerprint('sha256:old', current)).toEqual({
      kind: 'mismatch',
      current,
      stored: 'sha256:old',
    });
  });
});
