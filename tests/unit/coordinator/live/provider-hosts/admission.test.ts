import { describe, expect, it, vi } from 'vitest';

import type { SpawnProviderServerFn } from '#src/providers/app-server-transport.js';
import type {
  ProviderResponseDiagnosticFact,
  ProviderResponseObservationSink,
} from '#src/providers/host-diagnostics.js';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createExclusiveSpec, createFakeProviderServerHandle, createSharedSpec, runtime } from './helpers.js';

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
    const spawnProviderServer = vi.fn<SpawnProviderServerFn>(async (_options, sink) => {
      sinks.push(sink);
      const handle = handles.shift();
      if (handle === undefined) throw new Error('unexpected replacement spawn');
      return handle;
    });
    let generation = 101;
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer,
      allocateProviderServerGeneration: () => generation++,
    });
    const hostSpec = createSharedSpec({ provider: 'codex', idleRetirement: 'none' });

    const opened = await manager.openSession(hostSpec);
    sinks[0]?.(rejectedConfigRead(101));
    expect(manager.admissionSnapshot().state.values().next().value).toMatchObject({
      ref: opened.hostRef,
      generation: 101,
      phase: 'blocked-live',
    });

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
    await expect(manager.openSession(hostSpec)).rejects.toMatchObject({ code: 'provider_host_unserviceable' });

    expect(manager.confirmEvicted({ ...opened.hostRef, instanceId: 'stale-instance' })).toBe(false);
    expect(manager.confirmEvicted(opened.hostRef)).toBe(true);
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

  it('keys job-exclusive admission by owner job and single-flights concurrent opens within that slot', async () => {
    const first = createFakeProviderServerHandle({ generation: 201 });
    const second = createFakeProviderServerHandle({ generation: 202 });
    const sinks: ProviderResponseObservationSink[] = [];
    const handles = [first.handle, second.handle];
    const spawnProviderServer = vi.fn<SpawnProviderServerFn>(async (_options, sink) => {
      sinks.push(sink);
      const handle = handles.shift();
      if (handle === undefined) throw new Error('unexpected third spawn');
      return handle;
    });
    let generation = 201;
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer,
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
});
