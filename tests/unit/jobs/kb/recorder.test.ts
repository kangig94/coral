import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { KbJobRecorder } from '#src/jobs/kb/recorder.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
function createRecorder(): {
  recorder: KbJobRecorder;
  abortRegistry: AbortRegistry;
  progressStore: JobStore;
} {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const runtime = new SimulationRuntime();
  const progressStore = new JobStore('test-ns', runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const abortRegistry = new AbortRegistry(runtime.ids);
  const recorder = new KbJobRecorder({
    runtime,
    progressStore,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-a',
    abortRegistry,
  });
  return { recorder, abortRegistry, progressStore };
}

describe('KbJobRecorder.startInternalJob', () => {
  it('returns a run handle whose signal aborts with reason "user_abort" when the registry aborts the job', () => {
    const { recorder, abortRegistry } = createRecorder();

    const { jobId, signal } = recorder.startInternalJob({
      projectRoot: '/workspace/coral',
      operation: 'kb.reindex',
      request: {},
    });

    expect(signal.aborted).toBe(false);

    const result = abortRegistry.abort([jobId]);

    expect(result.aborted).toEqual([jobId]);
    expect(result.notFound).toEqual([]);
    expect(signal.aborted).toBe(true);
    // The callback owns the reason because AbortRegistry.abort() calls
    // controller.abort() without one.
    expect(signal.reason).toBe('user_abort');
  });

  it('finalize() removes the controller from the registry and is idempotent', () => {
    const { recorder, abortRegistry } = createRecorder();

    const { jobId, finalize } = recorder.startInternalJob({
      projectRoot: '/workspace/coral',
      operation: 'kb.reindex',
      request: {},
    });

    expect(abortRegistry.has(jobId)).toBe(true);

    finalize();
    expect(abortRegistry.has(jobId)).toBe(false);

    // Idempotent — second call must not throw or repeat side effects.
    finalize();
    expect(abortRegistry.has(jobId)).toBe(false);

    // Aborting after finalize reports notFound — the registry is the
    // single source of truth for live KB job ids.
    expect(abortRegistry.abort([jobId])).toEqual({ aborted: [], notFound: [jobId] });
  });

  it('aborting a finalized job does not retroactively trigger the signal', () => {
    const { recorder, abortRegistry } = createRecorder();

    const { jobId, signal, finalize } = recorder.startInternalJob({
      projectRoot: '/workspace/coral',
      operation: 'kb.reindex',
      request: {},
    });

    finalize();
    abortRegistry.abort([jobId]);

    expect(signal.aborted).toBe(false);
  });

  it('persists the configured internal job owner in the runtime record', () => {
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const runtime = new SimulationRuntime();
    const progressStore = new JobStore('test-ns', runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    });
    const abortRegistry = new AbortRegistry(runtime.ids);
    const recorder = new KbJobRecorder({
      runtime,
      progressStore,
      backendNamespace: 'test-ns',
      bundleHash: 'bundle-a',
      abortRegistry,
      internalJobOwner: 'kb-daemon',
    });

    const { jobId } = recorder.startInternalJob({
      projectRoot: '/workspace/coral',
      operation: 'kb.reindex',
      request: {},
    });

    expect(progressStore.readRuntimeProjection(jobId)).toMatchObject({
      transport: 'internal',
      operation: 'kb.reindex',
      owner: 'kb-daemon',
    });
  });
});
