import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { KbOperationJobShell, type KbOperationJobContext } from '#src/kb-daemon/services/shell.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
function createShell(): {
  shell: KbOperationJobShell;
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
  const shell = new KbOperationJobShell({
    runtime,
    progressStore,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-a',
    abortRegistry,
  });
  return { shell, abortRegistry, progressStore };
}

function reindexContext(): KbOperationJobContext {
  return {
    projectRoot: '/workspace/coral',
    request: {},
    failure: {
      code: 'kb_reindex_failed',
      abortedCode: 'kb_reindex_aborted',
      operation: 'reindex',
      message: (cause) => `KB reindex failed: ${cause.message}`,
      detail: (cause) => ({ operation: 'reindex', cause }),
    },
  };
}

describe('KbOperationJobShell', () => {
  it('runSync normalizes thrown errors and records the failed terminal through the recorder', async () => {
    const { shell, progressStore, abortRegistry } = createShell();
    let jobId = '';

    const result = await shell.runSync('kb.reindex', reindexContext(), async (job) => {
      jobId = job.jobId;
      throw new Error('index exploded');
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'kb_reindex_failed',
      message: 'index exploded',
      detail: {
        job: jobId,
        detail: { message: 'index exploded' },
      },
    });
    expect(abortRegistry.has(jobId)).toBe(false);
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'error',
      result: {
        content: '',
        outcome: { kind: 'failed' },
      },
    });
  });

  it('runSync applies the pre-terminal abort fence before recording completion', async () => {
    const { shell, progressStore, abortRegistry } = createShell();
    let jobId = '';

    const result = await shell.runSync('kb.reindex', reindexContext(), async (job) => {
      jobId = job.jobId;
      expect(abortRegistry.abort([job.jobId])).toEqual({ aborted: [job.jobId], notFound: [] });
      return {
        data: { rebuilt: true },
        terminalContent: 'should not be committed',
      };
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'kb_reindex_aborted',
      detail: { job: jobId },
    });
    expect(abortRegistry.has(jobId)).toBe(false);
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'aborted',
      result: {
        content: '',
        outcome: { kind: 'aborted', reason: 'user_abort' },
      },
    });
  });
});
