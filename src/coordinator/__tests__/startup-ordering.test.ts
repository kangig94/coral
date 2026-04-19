import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '../../runtime/real.js';
import { jobsReconcile } from '../../jobs/api.js';
import { ConsumerDriver } from '../consumer-driver.js';
import { createCoordinatorServer } from '../coordinator.js';

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('coordinator startup ordering', () => {
  it('waitFreshUntil resolves before jobsReconcile.runStartup is called', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-plugin-'));
    tempRoots.push(home, pluginRoot);

    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'startup-ordering-bundle', flavor: 'prod' }) + '\n',
      'utf-8',
    );

    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime();
    const order: string[] = [];
    const waitFreshUntil = vi.spyOn(ConsumerDriver.prototype, 'waitFreshUntil').mockImplementation(async () => {
      order.push('waitFreshUntil:start');
      await Promise.resolve();
      order.push('waitFreshUntil:resolved');
    });
    const runStartup = vi.spyOn(jobsReconcile, 'runStartup').mockImplementation(async () => {
      order.push('jobsReconcile.runStartup');
    });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      createKbSubsystemFn: async () => ({
        kb: { closeVectorStores: vi.fn(async () => {}) } as never,
        curateScheduler: {
          start: vi.fn(async () => {}),
          schedule: vi.fn(),
          scheduleDeferredCommit: vi.fn(),
          isRunning: () => false,
          stop: vi.fn(async () => {}),
        },
      }),
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
      registerBuiltInProvidersFn: () => {},
    });

    try {
      await coordinator.start();
      expect(waitFreshUntil).toHaveBeenCalledTimes(4);
      expect(runStartup).toHaveBeenCalledTimes(1);
      expect(order.indexOf('jobsReconcile.runStartup')).toBeGreaterThan(order.lastIndexOf('waitFreshUntil:resolved'));
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });
});
