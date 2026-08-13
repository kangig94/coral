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
  it('blocks only fresh placement, preserves exact attachment, and retains retirement until exact clearance', async () => {
    const first = createFakeProviderServerHandle({ generation: 101 });
    const second = createFakeProviderServerHandle({ generation: 102 });
    first.handle.inspectDiagnostics = () => ({
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 8 },
      completedObservations: [],
      factsTruncatedBeforeSeq: 13,
    });
    const handles = [first.handle, second.handle];
    const sinks: ProviderResponseObservationSink[] = [];
    const spawnProviderServer = vi.fn<SpawnProviderServerFn>(async (_options, sink, _generation, recordContainment) => {
      sinks.push(sink);
      const handle = handles.shift();
      if (handle === undefined) throw new Error('unexpected replacement spawn');
      recordContainment?.(handle.containmentIdentity);
      return handle;
    });
    let generation = 101;
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer,
      admission: createCoordinatorProviderHostAdmission(),
      allocateProviderServerGeneration: () => generation++,
    });
    const hostSpec = createSharedSpec({ provider: 'codex', idleRetirement: 'never' });

    const opened = await manager.openSession(hostSpec);
    sinks[0]?.(rejectedConfigRead(101));
    expect(manager.admissionSnapshot().state.values().next().value).toMatchObject({
      ref: opened.hostRef,
      generation: 101,
      phase: 'blocked-live',
    });
    expect(manager.listProviderHosts()).toEqual([
      expect.objectContaining({
        ref: opened.hostRef,
        status: 'live',
        spec: expect.objectContaining({ cwd: hostSpec.cwd }),
      }),
    ]);
    expect(manager.inspectProviderHost(opened.hostRef)).toMatchObject({ ref: opened.hostRef, status: 'live' });
    expect(first.closeMock, 'a negative finding performed a coordinator close').not.toHaveBeenCalled();

    const attached = await manager.attachSession(opened.hostRef, { spec: hostSpec, jobId: 'attached-job' });
    await expect(attached?.session.rpc('interrupt', {})).resolves.toEqual({});
    await expect(manager.openSession(hostSpec)).rejects.toMatchObject({
      code: 'provider_host_unserviceable',
      hostRef: opened.hostRef,
      remediation: { action: 'evict-provider-host' },
    });
    expect(spawnProviderServer).toHaveBeenCalledOnce();

    first.resolveClosed();
    await vi.waitFor(() =>
      expect(manager.admissionSnapshot().state.values().next().value?.phase).toBe('retired-blocked'),
    );
    const retired = manager.admissionSnapshot().tombstones[0];
    expect(retired).toMatchObject({
      ref: opened.hostRef,
      spec: { cwd: hostSpec.cwd },
      retirement: { status: 'retired', processAbsent: true },
      diagnostics: {
        hostLog: { truncatedBeforeSeq: 8 },
        factsTruncatedBeforeSeq: 13,
      },
    });
    expect(manager.listProviderHosts()).toEqual([
      expect.objectContaining({
        ref: opened.hostRef,
        status: 'retired-blocked',
        spec: expect.objectContaining({ cwd: hostSpec.cwd }),
      }),
    ]);
    expect(manager.inspectProviderHost(opened.hostRef)).toMatchObject({
      ref: opened.hostRef,
      status: 'retired-blocked',
    });
    await expect(manager.openSession(hostSpec)).rejects.toMatchObject({ code: 'provider_host_unserviceable' });

    expect(await manager.evictHost({ ...opened.hostRef, instanceId: 'stale-instance' })).toBe(false);
    expect(await manager.evictHost(opened.hostRef)).toBe(true);
    expect(first.closeMock, 'retired-blocked eviction attempted a second physical close').not.toHaveBeenCalled();
    const replacement = await manager.openSession(hostSpec);
    expect(replacement.hostRef.instanceId).not.toBe(opened.hostRef.instanceId);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);

    sinks[0]?.(rejectedConfigRead(102));
    expect(manager.admissionSnapshot().state.values().next().value).toMatchObject({
      ref: replacement.hostRef,
      generation: 102,
      phase: 'live',
    });

    attached?.close();
    opened.close();
    replacement.close();
    second.resolveClosed();
    await manager.shutdown();
  });

  it('returns provider_host_draining when eviction is reclaiming a blocked-live host', async () => {
    const server = createFakeProviderServerHandle({ generation: 103 });
    const reapStarted = createDeferred<void>();
    const finishReap = createDeferred<void>();
    let sink: ProviderResponseObservationSink | undefined;
    const manager = new StubbedContainmentProviderHostManager({
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
    await expect(eviction).resolves.toBe(true);
    opened.close();
    await manager.shutdown();
  });

  it('correlates an openSession RPC rejection to its exact blocked coordinator host', async () => {
    const providerCause = new Error('coordinator provider RPC rejected');
    const server = createFakeProviderServerHandle({
      generation: 151,
      request: async (method) => {
        if (method === 'turn/start') throw providerCause;
        return {};
      },
    });
    let sink: ProviderResponseObservationSink | undefined;
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      admission: createCoordinatorProviderHostAdmission(),
      spawnProviderServer: async (_options, observationSink, _generation, recordContainment) => {
        sink = observationSink;
        recordContainment?.(server.handle.containmentIdentity);
        return server.handle;
      },
      allocateProviderServerGeneration: () => 151,
    });
    const opened = await manager.openSession(createSharedSpec({ provider: 'codex', idleRetirement: 'never' }));
    sink?.(rejectedConfigRead(151));

    const rejection = await opened.session.rpc('turn/start', {}).catch((error: unknown) => error);

    opened.close();
    await manager.shutdown();
    expect(rejection, 'coordinator openSession RPC lost its exact blocked host reference').toMatchObject({
      name: 'ProviderHostUnserviceableResponseError',
      hostRef: opened.hostRef,
    });
    expect(
      (rejection as { providerCause?: unknown }).providerCause,
      'coordinator openSession RPC lost the raw provider cause',
    ).toBe(providerCause);
  });

  it('keys job-exclusive admission by owner job and single-flights concurrent opens within that slot', async () => {
    const first = createFakeProviderServerHandle({ generation: 201 });
    const second = createFakeProviderServerHandle({ generation: 202 });
    const sinks: ProviderResponseObservationSink[] = [];
    const handles = [first.handle, second.handle];
    const spawnProviderServer = vi.fn<SpawnProviderServerFn>(async (_options, sink, _generation, recordContainment) => {
      sinks.push(sink);
      const handle = handles.shift();
      if (handle === undefined) throw new Error('unexpected third spawn');
      recordContainment?.(handle.containmentIdentity);
      return handle;
    });
    let generation = 201;
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      spawnProviderServer,
      admission: createCoordinatorProviderHostAdmission(),
      allocateProviderServerGeneration: () => generation++,
    });
    const hostSpec = createExclusiveSpec();

    const [jobAFirst, jobASecond] = await Promise.all([
      manager.openSession(hostSpec, { jobId: 'job-a' }),
      manager.openSession(hostSpec, { jobId: 'job-a' }),
    ]);
    expect(jobAFirst.hostRef).toEqual(jobASecond.hostRef);
    expect(spawnProviderServer).toHaveBeenCalledOnce();
    sinks[0]?.(rejectedConfigRead(201));

    const jobB = await manager.openSession(hostSpec, { jobId: 'job-b' });
    expect(jobB.hostRef.instanceId).not.toBe(jobAFirst.hostRef.instanceId);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);
    await expect(manager.openSession(hostSpec, { jobId: 'job-a' })).rejects.toMatchObject({
      code: 'provider_host_unserviceable',
      hostRef: jobAFirst.hostRef,
    });

    jobAFirst.close();
    jobASecond.close();
    jobB.close();
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
    await expect(eviction).resolves.toBe(true);
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
