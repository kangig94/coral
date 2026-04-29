import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { KbJobRecorder } from '#src/coordinator/services/kb/recorder.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/job-store.js';
import type { StoragePort } from '#src/runtime/ports.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: readFileSync as StoragePort['readFileSync'],
  readdirSync: readdirSync as StoragePort['readdirSync'],
};

function createRecorder(): {
  recorder: KbJobRecorder;
  abortRegistry: AbortRegistry;
} {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  const runtime = new SimulationRuntime();
  const progressStore = new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), { db });
  const abortRegistry = new AbortRegistry(runtime.ids);
  const recorder = new KbJobRecorder({
    runtime,
    progressStore,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-a',
    abortRegistry,
  });
  return { recorder, abortRegistry };
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
});
