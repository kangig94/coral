import { describe, expect, it } from 'vitest';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import {
  createExclusiveSpec,
  createFakeProviderServerHandle,
  createLaunch,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

describe('provider host recovery', () => {
  it('borrows a live exclusive host only when the generation matches', async () => {
    const server = createFakeProviderServerHandle({ generation: 41 });
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });

    const spec = createExclusiveSpec();
    const lease = await manager.acquireServer(createLaunch(spec), { jobId: 'job-a' });
    const borrowed = await manager.borrowLiveServer(spec, { serverGeneration: 41, jobId: 'job-a' });
    const mismatched = await manager.borrowLiveServer(spec, { serverGeneration: 99, jobId: 'job-a' });

    expect(borrowed).not.toBeNull();
    expect(mismatched).toBeNull();
    await expect(
      borrowed?.rpc('ping', { ok: true }) ?? Promise.reject(new Error('missing attachment')),
    ).resolves.toEqual({});

    lease.release();
    await expect(manager.borrowLiveServer(spec, { serverGeneration: 41, jobId: 'job-a' })).resolves.toBeNull();
    await manager.shutdown();
  });

  it('passes initializeRequest from spec to spawnProviderServer options', async () => {
    const server = createFakeProviderServerHandle({ generation: 50 });
    const spawnProviderServer = createSpawnProviderServerMock(server.handle);
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });

    const spec = createExclusiveSpec({
      initializeRequest: {
        method: 'initialize',
        params: { clientInfo: { name: 'coral', version: '0.5.0' } },
      },
      initializeTimeoutMs: 12_345,
    });

    const lease = await manager.acquireServer(createLaunch(spec), { jobId: 'job-a' });
    expect(spawnProviderServer).toHaveBeenCalledWith(
      expect.objectContaining({
        initializeRequest: {
          method: 'initialize',
          params: { clientInfo: { name: 'coral', version: '0.5.0' } },
        },
        initializeTimeoutMs: 12_345,
      }),
    );
    lease.release();
    await manager.shutdown();
  });

  it('fails closed for missing generation, wrong job, and wrong requested lease policy', async () => {
    const server = createFakeProviderServerHandle({ generation: 61 });
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
    });
    const spec = createExclusiveSpec();
    const lease = await manager.acquireServer(createLaunch(spec), { jobId: 'job-a' });

    await expect(manager.borrowLiveServer(spec, { jobId: 'job-a' })).resolves.toBeNull();
    await expect(manager.borrowLiveServer(spec, { serverGeneration: 61, jobId: 'job-b' })).resolves.toBeNull();
    await expect(
      manager.borrowLiveServer({ ...spec, leaseMode: 'shared' }, { serverGeneration: 61, jobId: 'job-a' }),
    ).resolves.toBeNull();

    lease.release();
    await manager.shutdown();
  });
});
