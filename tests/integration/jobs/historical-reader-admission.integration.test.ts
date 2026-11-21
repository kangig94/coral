import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { it, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { registerPresentHistoricalEpochs, readHistoricalSource } from '#src/jobs/historical-reader.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import * as retainedCurrent from '#src/jobs/retained-current.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

it('admits unindexed historical jobs read-only and rejects foreign jobs before loading their details', async () => {
  const f = createTerminalExportFixture('provider', true);
  const loadDetail = vi.spyOn(retainedCurrent, 'loadRetainedCurrentJob');
  try {
    f.complete();
    rmSync(f.locationPath); // released <=0.10.15 epochs carry no location records
    const entry = {
      resolved: f.epoch,
      epochKey: f.epochKey,
      epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } } },
    } as never;
    registerPresentHistoricalEpochs(f.runtime, f.index, [entry], 'new-active-epoch', { remaining: 0 });

    const direct = readHistoricalSource(f.index, f.epochKey, [f.jobId]);
    expect(direct.kind === 'read' && direct.locations.get(f.jobId)?.disposition).toBe('terminal');

    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'new-active-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      undefined,
      () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
    );
    const admitted = addressing.admitWait({ jobIds: [f.jobId] } as never);

    expect(admitted[0].disposition).toBe('admitted');
    expect(loadDetail).toHaveBeenCalled();
    loadDetail.mockClear();
    const projectRoot = join(f.root, 'unrelated');
    mkdirSync(projectRoot);
    const spec = rpcCatalog.find((method) => method.name === 'jobs.wait.snapshot')!;
    const ports = {
      jobs: { snapshot: addressing.snapshot.bind(addressing) },
    } as unknown as HttpHandlerPorts;
    const snapshot = await executeCatalogRequest(
      spec,
      spec.requestSchema.parse({ jobIds: [f.jobId], projectRoot }),
      ports,
      testProjectPrincipal(projectRoot),
    );
    expect(snapshot).toMatchObject({ body: { jobs: [{ jobId: f.jobId, disposition: 'scope-mismatch' }] } });
    expect(loadDetail).not.toHaveBeenCalled();
    expect(f.index.read(f.jobId)).toBeNull();
  } finally {
    loadDetail.mockRestore();
    f.close();
  }
});

it.each(['jobs.detail', 'jobs.wait', 'jobs.wait.snapshot'])(
  'rejects a foreign job before reading execution evidence in %s',
  async (method) => {
    const f = createTerminalExportFixture('provider', true);
    const active = newRawDatabase(':memory:');
    const loadDetail = vi.spyOn(retainedCurrent, 'loadRetainedCurrentJob');
    try {
      applyBundledStoreSchema(active, currentCoralStoreFormat());
      f.complete();
      const projectRoot = join(f.root, 'unrelated');
      mkdirSync(projectRoot);
      if (method === 'jobs.detail') {
        rmSync(f.locationPath);
        registerPresentHistoricalEpochs(
          f.runtime,
          f.index,
          [
            {
              resolved: f.epoch,
              epochKey: f.epochKey,
              epochJson: {
                kind: 'valid',
                value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } },
              },
            } as never,
          ],
          'new-active-epoch',
          { remaining: 0 },
        );
      } else {
        const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
        expect(stored.executions).not.toHaveLength(0);
        stored.executions[0].detail = null;
        writeFileSync(f.locationPath, JSON.stringify(stored));
      }
      const addressing = new JobAddressing(
        f.index.readOnlyView(),
        {
          visitProgress: progressVisitFromDetails(() => null),
          epochKey: () => 'new-active-epoch',
          detail: () => null,
          address: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'decided',
        undefined,
        () => ({ kind: 'pending' }),
      );
      const ports = createCoordinatorRpcPorts({
        jobAddressing: addressing,
        getProgressStore: () => ({ getDb: () => active }),
        services: { jobAttention: new JobAttention() },
        time: f.runtime.time,
        waitHandoverSignal: () => new AbortController().signal,
      } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]) as unknown as HttpHandlerPorts;
      loadDetail.mockClear();
      const spec = rpcCatalog.find((entry) => entry.name === method)!;
      const response = await executeCatalogRequest(
        spec,
        spec.requestSchema.parse({
          projectRoot,
          ...(method === 'jobs.detail'
            ? { jobId: f.jobId }
            : { jobIds: [f.jobId], waitRpcVersion: 2, ...(method === 'jobs.wait' ? { cursor: null } : {}) }),
        }),
        ports,
        testProjectPrincipal(projectRoot),
      );
      if (method === 'jobs.detail') {
        expect(response).toMatchObject({ statusCode: 403, body: { code: 'scope_mismatch' } });
      } else if (method === 'jobs.wait.snapshot') {
        expect(response).toMatchObject({ body: { jobs: [{ jobId: f.jobId, disposition: 'scope-mismatch' }] } });
      } else {
        if (response.kind !== 'subscription') throw new Error('Expected a streaming wait response');
        const events = [];
        for await (const event of response.notifications) events.push(event);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'disposition',
            jobId: f.jobId,
            disposition: 'scope-mismatch',
          }),
        );
      }
      expect(loadDetail).not.toHaveBeenCalled();
    } finally {
      loadDetail.mockRestore();
      active.close();
      f.close();
    }
  },
);
