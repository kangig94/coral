import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { persistedDiscussSnapshotSchema } from '#src/discuss/projections.js';
import { declarativeEngineManifestSchema } from '#src/expansion/manifest/schema.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { jobDiagnosticsSchema, jobTerminalSchema } from '#src/jobs/terminal/result.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { sessionEntrySchema } from '#src/sessions/entry.js';
import { createCurrentStoreFormat } from '#src/store/current-format.js';
import { journalEventRefsSchema } from '#src/store/envelope.js';
import {
  compareStoreFormatFingerprint,
  ddlWithoutPersistedCodecAnnotations,
  describeStoreFormat,
  persistedCodecNamesFromDdl,
  PersistedCodecRegistry,
} from '#src/store/format-fingerprint.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { workflowPlanSchema } from '#src/workflow/plan.js';
import { corpusAuthorityBaselineDdl } from '#src/kb/corpus/rescan/authority-baseline.js';

const CURRENT_CODEC_NAMES = [
  'store.events.body',
  'store.events.refs',
  'store.expansion_manifest_catalog.manifest',
  'store.kb_curate_retry_queue.signals',
  'store.projection_discuss.state',
  'store.projection_jobs.diagnostics',
  'store.projection_jobs.terminal',
  'store.projection_sessions.entry',
  'store.projection_workflows.plan',
] as const;

function ddlFor(...codecNames: readonly string[]): string {
  return codecNames.map((name, index) => `value_${index} TEXT -- JSON @persisted-codec ${name}`).join('\n');
}

const currentCodecSchemas = {
  eventRefs: journalEventRefsSchema,
  jobTerminal: jobTerminalSchema,
  jobDiagnostics: jobDiagnosticsSchema,
  sessionEntry: sessionEntrySchema,
  discussState: persistedDiscussSnapshotSchema,
  workflowPlan: workflowPlanSchema,
  expansionManifest: declarativeEngineManifestSchema,
};

describe('StoreFormatFingerprint', () => {
  it('describes every current persisted JSON boundary and every Journal event codec', () => {
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const format = createCurrentStoreFormat(reducers, currentCodecSchemas, [corpusAuthorityBaselineDdl]);

    expect(format.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(format.manifest.codecs.map((entry) => entry.name)).toEqual(CURRENT_CODEC_NAMES);
    expect(persistedCodecNamesFromDdl(format.manifest.ddl)).toEqual(CURRENT_CODEC_NAMES);
    expect(format.manifest.ddl).toContain('-- @persisted-ddl kb.corpus.authority-baseline');
    expect(format.manifest.ddl).toContain('CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline_records');

    const eventCodec = format.manifest.codecs.find((entry) => entry.name === 'store.events.body');
    const eventContract = eventCodec?.contract as { events?: readonly { type?: unknown }[] } | undefined;
    expect(eventContract?.events?.map((entry) => entry.type)).toEqual([...reducers.schemas.keys()].sort());
  });

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

  it('keeps shadow codec annotations out of the active pre-B09 DDL marker input', () => {
    const original = 'value TEXT, -- JSON payload\nother TEXT,\n';
    const annotated =
      'value TEXT, -- JSON payload @persisted-codec store.value\n' +
      'other TEXT, -- JSON @persisted-codec store.other\n';

    expect(ddlWithoutPersistedCodecAnnotations(annotated)).toBe(original);
  });

  it('provides the pure fingerprint decision B09 will connect to reset authority', () => {
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
