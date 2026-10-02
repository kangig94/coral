import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '#tools/testing/deferred.js';
import type { SpawnProviderServerFn } from '#src/providers/app-server-transport.js';
import type {
  ProviderResponseDiagnosticFact,
  ProviderResponseObservationSink,
} from '#src/providers/host-diagnostics.js';
import { createCoordinatorProviderHostAdmission } from '#src/coordinator/live/provider-host-admission.js';
import {
  StubbedContainmentProviderHostManager,
  noCarrierBlocksRetirement,
  createExclusiveSpec,
  createFakeProviderServerHandle,
  createSharedSpec,
  runtime,
} from './helpers.js';

function rejectedConfigRead(generation: number): ProviderResponseDiagnosticFact {
  return Object.freeze({
    factSeq: 1,
    generation,
    requestId: 1,
    method: 'config/read',
    response: Object.freeze({
      kind: 'failure',
      rpcCode: -32_603,
      providerMessage: 'fixture rejection',
      providerData: { cause: 'fixture' },
    }),
    hostLog: Object.freeze({ startSeq: 4, endSeq: 5 }),
  });
}

describe('coordinator provider-host admission', () => {
  it('returns provider_host_draining when eviction is reclaiming a blocked-live host', async () => {
    const server = createFakeProviderServerHandle({ generation: 103 });
    const reapStarted = createDeferred<void>();
    const finishReap = createDeferred<void>();
    let sink: ProviderResponseObservationSink | undefined;
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      admission: createCoordinatorProviderHostAdmission(),
      spawnProviderServer: async (_options, observationSink, _generation, recordContainment) => {
        sink = observationSink;
        recordContainment?.(server.handle.containmentIdentity);
        return server.handle;
      },
      reapContainment: async () => {
        reapStarted.resolve();
        await finishReap.promise;
      },
      allocateProviderServerGeneration: () => 103,
    });
    const hostSpec = createSharedSpec({ provider: 'codex', idleRetirement: 'never' });
    const opened = await manager.openSession(hostSpec);
    sink?.(rejectedConfigRead(103));
    expect(manager.admissionSnapshot().state.values().next().value?.phase).toBe('blocked-live');

    const eviction = manager.evictHost(opened.hostRef);
    await reapStarted.promise;

    await expect(manager.openSession(hostSpec)).rejects.toThrow(/^provider_host_draining:/u);

    finishReap.resolve();
    await expect(eviction).resolves.toEqual({ kind: 'evicted' });
    opened.close();
    await manager.shutdown();
  });

  it('awaits exact live coordinator close before confirmation and leaves another live job untouched', async () => {
    const evictedClose = createDeferred<void>();
    const evictedRpc = createDeferred<unknown>();
    const continuingRpc = createDeferred<unknown>();
    const evicted = createFakeProviderServerHandle({
      generation: 301,
      request: (method) => (method === 'live/job' ? evictedRpc.promise : Promise.resolve({})),
      close: () => {
        evictedRpc.reject(new Error('evicted coordinator host closed'));
        return evictedClose.promise;
      },
    });
    const untouched = createFakeProviderServerHandle({
      generation: 302,
      request: (method) => (method === 'live/job' ? continuingRpc.promise : Promise.resolve({})),
    });
    const replacement = createFakeProviderServerHandle({ generation: 303 });
    const handles = [evicted.handle, untouched.handle, replacement.handle];
    const sinks: ProviderResponseObservationSink[] = [];
    const spawnProviderServer = vi.fn<SpawnProviderServerFn>(async (_options, sink, _generation, recordContainment) => {
      sinks.push(sink);
      const handle = handles.shift();
      if (handle === undefined) throw new Error('unexpected fourth spawn');
      recordContainment?.(handle.containmentIdentity);
      return handle;
    });
    let generation = 301;
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      spawnProviderServer,
      admission: createCoordinatorProviderHostAdmission(),
      allocateProviderServerGeneration: () => generation++,
    });
    const hostSpec = createExclusiveSpec();
    const first = await manager.openSession(hostSpec, { jobId: 'job-a' });
    const second = await manager.openSession(hostSpec, { jobId: 'job-b' });
    const evictedJob = first.session.rpc('live/job', {}).then(
      () => null,
      (error: unknown) => error,
    );
    const liveJob = second.session.rpc('live/job', {});
    sinks[0]?.(rejectedConfigRead(301));

    let evictionSettled = false;
    const eviction = manager.evictHost(first.hostRef).then((result) => {
      evictionSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(evicted.closeMock, 'ref A exact live close was not selected').toHaveBeenCalledOnce());
    await expect(evictedJob).resolves.toMatchObject({ message: 'evicted coordinator host closed' });

    expect(evictionSettled, 'ref A eviction settled before ref A exact live close').toBe(false);
    await expect(
      manager.openSession(hostSpec, { jobId: 'job-a' }),
      'ref A admission reopened before ref A exact live close settled',
    ).rejects.toThrow(/^provider_host_draining:/u);
    expect(untouched.closeMock, 'ref B was closed while evicting ref A').not.toHaveBeenCalled();

    evictedClose.resolve();
    await expect(eviction).resolves.toEqual({ kind: 'evicted' });
    const reopened = await manager.openSession(hostSpec, { jobId: 'job-a' });
    expect(reopened.hostRef.instanceId).not.toBe(first.hostRef.instanceId);
    expect(untouched.closeMock, 'ref B was closed while evicting ref A').not.toHaveBeenCalled();
    continuingRpc.resolve({ continued: true });
    await expect(liveJob).resolves.toEqual({ continued: true });

    first.close();
    second.close();
    reopened.close();
    await manager.shutdown();
  });

  it('keeps coordinator admission gated as draining when exact live close fails', async () => {
    const server = createFakeProviderServerHandle({
      generation: 401,
      close: async () => {
        throw new Error('coordinator close refused');
      },
    });
    let sink: ProviderResponseObservationSink | undefined;
    const manager = new StubbedContainmentProviderHostManager({
      carrierBlocksRetirement: noCarrierBlocksRetirement,
      runtime,
      admission: createCoordinatorProviderHostAdmission(),
      spawnProviderServer: async (_options, observationSink, _generation, recordContainment) => {
        sink = observationSink;
        recordContainment?.(server.handle.containmentIdentity);
        return server.handle;
      },
      allocateProviderServerGeneration: () => 401,
    });
    const hostSpec = createSharedSpec({ provider: 'codex', idleRetirement: 'never' });
    const opened = await manager.openSession(hostSpec);
    sink?.(rejectedConfigRead(401));

    await expect(manager.evictHost(opened.hostRef)).rejects.toThrow('coordinator close refused');
    expect(manager.admissionSnapshot().state.values().next().value).toMatchObject({
      ref: opened.hostRef,
      phase: 'blocked-live',
    });
    await expect(manager.openSession(hostSpec)).rejects.toThrow(/^provider_host_draining:/u);
    opened.close();
  });
});
