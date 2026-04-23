import { describe, expect, it } from 'vitest';
import { DefaultProviderHostManager, hostKeyFromSpec } from '#src/coordinator/live/provider-hosts/pool.js';
import { createExclusiveSpec, createFakeProviderServerHandle, createSharedSpec, createSpawnProviderServerMock, runtime } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

describe('provider host pool', () => {
  it('hostKeyFromSpec normalizes env ordering and separates incompatible hosts', () => {
    const base = createExclusiveSpec({ args: ['app-server'], cwd: '/workspace/a' });

    expect(hostKeyFromSpec(base)).toBe(
      hostKeyFromSpec({
        ...base,
        env: {},
      }),
    );
    expect(
      hostKeyFromSpec({
        ...base,
        env: {
          BETA: '2',
          ALPHA: '1',
        },
      }),
    ).toBe(
      hostKeyFromSpec({
        ...base,
        env: {
          ALPHA: '1',
          BETA: '2',
        },
      }),
    );
    expect(hostKeyFromSpec({ ...base, cwd: '/workspace/b' })).not.toBe(hostKeyFromSpec(base));
  });

  it('reuses one shared host and isolates incompatible exclusive hosts', async () => {
    const firstHandle = createFakeProviderServerHandle({ generation: 11 });
    const secondHandle = createFakeProviderServerHandle({ generation: 22 });
    const thirdHandle = createFakeProviderServerHandle({ generation: 33 });
    const spawnProviderServer = createSpawnProviderServerMock(
      firstHandle.handle,
      secondHandle.handle,
      thirdHandle.handle,
    );
    const manager = new DefaultProviderHostManager({ runtime, spawnProviderServer });

    const sharedSpec = createSharedSpec();
    const codexSpecA = createExclusiveSpec({
      cwd: '/workspace/a',
      env: { PROJECT: 'a' },
    });
    const codexSpecB = createExclusiveSpec({
      cwd: '/workspace/b',
      env: { PROJECT: 'b' },
    });

    const sharedLeaseA = await manager.acquireServer(sharedSpec);
    const sharedLeaseB = await manager.acquireServer(sharedSpec);
    const codexLeaseA = await manager.acquireServer(codexSpecA);
    const codexLeaseB = await manager.acquireServer(codexSpecB);

    expect(sharedLeaseA.generation).toBe(11);
    expect(sharedLeaseB.generation).toBe(11);
    expect(codexLeaseA.generation).toBe(22);
    expect(codexLeaseB.generation).toBe(33);
    expect(spawnProviderServer).toHaveBeenCalledTimes(3);

    sharedLeaseA.release();
    sharedLeaseB.release();
    codexLeaseA.release();
    codexLeaseB.release();
    await manager.shutdown();
  });
});
