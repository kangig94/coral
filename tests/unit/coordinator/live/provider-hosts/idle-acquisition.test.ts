import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '#tools/testing/deferred.js';
import type { RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import { backendLog } from '#src/infra/backend-log.js';
import {
  StubbedContainmentProviderHostManager,
  noCarrierBlocksRetirement,
  createFakeProviderServerHandle,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from './helpers.js';

async function createIdleCloseRace() {
  vi.useFakeTimers();
  const finishReap = createDeferred<void>();
  const retiring = createFakeProviderServerHandle({ generation: 701 });
  const replacement = createFakeProviderServerHandle({ generation: 702 });
  const spawnProviderServer = createSpawnProviderServerMock(retiring.handle, replacement.handle);
  const reapContainment = vi.fn(async (containment: RecordedContainmentIdentity) => {
    if (containment.pid === retiring.handle.pid) await finishReap.promise;
  });
  const manager = new StubbedContainmentProviderHostManager({
    runtime,
    idleTimeoutMs: 10,
    carrierBlocksRetirement: noCarrierBlocksRetirement,
    spawnProviderServer,
    reapContainment,
  });
  const spec = createSharedSpec({ provider: 'codex', idleRetirement: 'unleased' });
  const first = await manager.openSession(spec, { jobId: 'old-job' });
  first.close();
  return { manager, spec, first, finishReap, retiring, replacement, spawnProviderServer, reapContainment };
}

describe('provider host acquisition during idle retirement', () => {
  it('waits for committed idle reaping and shares one fresh host between arriving jobs', async () => {
    const { manager, spec, first, finishReap, retiring, replacement, spawnProviderServer, reapContainment } =
      await createIdleCloseRace();
    vi.advanceTimersByTime(10);
    expect(reapContainment).toHaveBeenCalledOnce();
    const outcomes: unknown[] = [];
    const arriving = ['job-a', 'job-b'].map((jobId) =>
      manager.openSession(spec, { jobId }).then(
        (session) => {
          outcomes.push(session);
          return session;
        },
        (error: unknown) => {
          outcomes.push(error);
          throw error;
        },
      ),
    );
    const acquired = Promise.all(arriving);
    void acquired.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([]);
    expect(spawnProviderServer).toHaveBeenCalledOnce();
    expect(await manager.attachSession(first.hostRef, { spec, jobId: 'old-job' })).toBeNull();

    finishReap.resolve();
    const [a, b] = await acquired;
    expect(retiring.finishCloseAfterReapMock).toHaveBeenCalledOnce();
    expect(retiring.handle.isClosed()).toBe(true);
    expect(spawnProviderServer).toHaveBeenCalledTimes(2);
    expect(a.hostRef.instanceId).not.toBe(first.hostRef.instanceId);
    expect(b.hostRef).toEqual(a.hostRef);
    await expect(a.session.rpc('job/start', {})).resolves.toEqual({});
    expect(replacement.requestMock).toHaveBeenCalledWith('job/start', {});
    a.close();
    b.close();
    await manager.shutdown();
  });

  it('cancels the idle timer when acquisition pins the host before close commits', async () => {
    const { manager, spec, first, finishReap, retiring, spawnProviderServer, reapContainment } =
      await createIdleCloseRace();
    vi.advanceTimersByTime(9);
    const arriving = await manager.openSession(spec, { jobId: 'new-job' });
    await vi.advanceTimersByTimeAsync(1);
    expect(arriving.hostRef).toEqual(first.hostRef);
    expect(reapContainment).not.toHaveBeenCalled();
    expect(retiring.markExpectedCloseMock).not.toHaveBeenCalled();
    expect(spawnProviderServer).toHaveBeenCalledOnce();
    finishReap.resolve();
    arriving.close();
    await manager.shutdown();
  });

  it('bounds acquisition waiting without interrupting committed reaping', async () => {
    const { manager, spec, finishReap, retiring, spawnProviderServer, reapContainment } = await createIdleCloseRace();
    vi.advanceTimersByTime(10);
    const acquired = manager.openSession(spec).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(acquired).resolves.toMatchObject({ message: expect.stringContaining('provider_host_draining:') });
    expect(spawnProviderServer).toHaveBeenCalledOnce();
    expect(reapContainment).toHaveBeenCalledOnce();
    expect(retiring.finishCloseAfterReapMock).not.toHaveBeenCalled();

    finishReap.resolve();
    await manager.shutdown();
    expect(retiring.finishCloseAfterReapMock).toHaveBeenCalledOnce();
  });

  it('aborts an arriving job without cancelling the retiring host close', async () => {
    const { manager, spec, finishReap, retiring, spawnProviderServer } = await createIdleCloseRace();
    vi.advanceTimersByTime(10);
    const controller = new AbortController();
    const acquired = manager.openSession(spec, { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(acquired).resolves.toBeInstanceOf(Error);
    expect(spawnProviderServer).toHaveBeenCalledOnce();
    expect(retiring.finishCloseAfterReapMock).not.toHaveBeenCalled();

    finishReap.resolve();
    await manager.shutdown();
    expect(retiring.finishCloseAfterReapMock).toHaveBeenCalledOnce();
  });

  it('refuses fresh placement when shutdown starts during an idle close wait', async () => {
    const { manager, spec, finishReap, retiring, spawnProviderServer } = await createIdleCloseRace();
    vi.advanceTimersByTime(10);
    const acquired = manager.openSession(spec).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const shutdown = manager.shutdown();
    await expect(acquired).resolves.toMatchObject({ message: expect.stringContaining('provider_host_draining:') });
    expect(spawnProviderServer).toHaveBeenCalledOnce();

    finishReap.resolve();
    await shutdown;
    expect(retiring.finishCloseAfterReapMock).toHaveBeenCalledOnce();
  });

  it('keeps admission closed when idle host reclamation fails', async () => {
    const { manager, spec, finishReap, spawnProviderServer, reapContainment } = await createIdleCloseRace();
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    vi.advanceTimersByTime(10);
    const acquired = manager.openSession(spec).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    finishReap.reject(new Error('fixture reap failure'));
    await expect(acquired).resolves.toMatchObject({ message: expect.stringContaining('provider_host_draining:') });
    await expect(manager.openSession(spec)).rejects.toThrow('provider_host_draining:');
    expect(spawnProviderServer).toHaveBeenCalledOnce();
    expect(reapContainment).toHaveBeenCalledOnce();
    expect(manager.listProviderHosts()).toMatchObject([{ status: 'reclamation-failed' }]);
  });
});
