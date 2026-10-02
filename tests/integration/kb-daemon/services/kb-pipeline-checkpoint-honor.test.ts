import { afterEach, expect, it, vi } from 'vitest';

import { KbReindexService } from '#src/kb-daemon/services/reindex.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobAbortRegistryPort } from '#src/jobs/contracts/abort-registry.js';
import type { KnowledgeBaseRuntime } from '#src/kb/runtime-contract.js';
import { AbortError } from '#src/runtime/abort.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

vi.mock('#src/kb/ops/reindex.js', () => ({
  reindex: async () => ({ notes: 0, sources: 0, communities: 0, wikis: 0, principles: 0 }),
}));

const databases: ReturnType<typeof openKbTestStoreDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function runAtCheckpoint(reason: 'user_abort' | { kind: 'mutation_deadline'; timeoutMs: number }) {
  const db = openKbTestStoreDb(':memory:');
  databases.push(db);
  const runtime = new SimulationRuntime();
  const store = new JobStore('checkpoint-test', runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const callbacks = new Map<string, () => void>();
  const abortRegistry: JobAbortRegistryPort = {
    register: (id, callback) => {
      callbacks.set(id!, callback!);
      return id!;
    },
    getSignal: () => null,
    has: (id) => callbacks.has(id),
    listActive: () => [...callbacks.keys()],
    abort: (ids) => {
      const aborted = ids.filter((id) => callbacks.has(id));
      for (const id of aborted) callbacks.get(id)!();
      return { aborted, notFound: ids.filter((id) => !callbacks.has(id)) };
    },
    remove: (id) => {
      callbacks.delete(id);
    },
  };
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const service = new KbReindexService({
    runtime,
    progressStore: store,
    backendNamespace: 'checkpoint-test',
    bundleHash: 'bundle-a',
    abortRegistry,
    waitForReadiness: async ({ signal }) => {
      entered.resolve();
      await release.promise;
      throw new AbortError({ stage: 'readiness', reason: reason === 'user_abort' ? signal?.reason : reason });
    },
  });
  const kbRuntime = {
    kb: {
      getCorpusStateSnapshot: () => ({
        snapshotId: 'snapshot',
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: 'h',
        metadataManifestHash: 'h',
      }),
    },
  } as KnowledgeBaseRuntime;
  const running = service.run({ async: false }, { projectRoot: '/workspace' }, kbRuntime);
  await entered.promise;
  const [jobId] = abortRegistry.listActive();
  if (reason === 'user_abort') expect(abortRegistry.abort([jobId])).toEqual({ aborted: [jobId], notFound: [] });
  release.resolve();
  const result = await running;
  return { result, outcome: store.readStatus(jobId)?.result?.outcome };
}

it('records an explicit user abort as aborted/user_abort', async () => {
  const { outcome } = await runAtCheckpoint('user_abort');
  expect(outcome).toEqual({ kind: 'aborted', reason: 'user_abort' });
});

it('records a mutation deadline as failed', async () => {
  const { result, outcome } = await runAtCheckpoint({ kind: 'mutation_deadline', timeoutMs: 1 });
  expect(result).toMatchObject({ ok: false, code: 'kb_reindex_failed' });
  expect(outcome).toMatchObject({ kind: 'failed' });
});
