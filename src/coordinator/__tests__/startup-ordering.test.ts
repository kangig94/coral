import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '../../runtime/real.js';
import { jobsReconcile } from '../../jobs/api.js';
import { ConsumerDriver } from '../consumer-driver.js';
import { createCoordinatorServer } from '../coordinator.js';
import type { CorpusSnapshot } from '../../kb/corpus/snapshot.js';
import { NEEDLE_CONSUMER_ID } from '../../kb/search/needle-backend.js';

const tempRoots: string[] = [];
const EMPTY_CORPUS_SNAPSHOT: CorpusSnapshot = {
  snapshotId: '',
  contentSeq: 0,
  metadataSeq: 0,
  contentManifestHash: '',
  metadataManifestHash: '',
};

function createMockKb(order?: string[]) {
  return {
    retryPendingCorpusPublication: vi.fn(async () => {
      order?.push('retryPendingCorpusPublication');
    }),
    withMutationLock: vi.fn(async (fn: () => Promise<unknown> | unknown) => {
      order?.push('withMutationLock:start');
      const result = await fn();
      order?.push('withMutationLock:end');
      return result;
    }),
    runEntrySeqUpgradeGuardIfNeeded: vi.fn(() => {
      order?.push('runEntrySeqUpgradeGuardIfNeeded');
      return false;
    }),
    ensureOramaIndex: vi.fn(async () => {
      order?.push('ensureOramaIndex');
      return {
        db: {} as never,
        tokenizer: {} as never,
        index: {
          entries: {},
          principles: {},
          entityMeta: {},
          relationships: [],
        },
      };
    }),
    getCorpusStateSnapshot: vi.fn(() => {
      order?.push('getCorpusStateSnapshot');
      return { ...EMPTY_CORPUS_SNAPSHOT };
    }),
  } as never;
}

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
        kb: createMockKb(),
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

  it('replays the persisted corpus snapshot before starting curate scheduling or opening read surfaces', async () => {
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
    const originalRegister = ConsumerDriver.prototype.register;
    const register = vi.spyOn(ConsumerDriver.prototype, 'register').mockImplementation(function (
      this: ConsumerDriver,
      reg,
    ) {
      if (reg.id === NEEDLE_CONSUMER_ID) {
        order.push('needle.register');
      }
      return originalRegister.call(this, reg);
    });
    const notifyCorpus = vi
      .spyOn(ConsumerDriver.prototype, 'notifyCorpus')
      .mockImplementation((_snapshot: CorpusSnapshot) => {
        order.push('notifyCorpus');
      });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      createKbSubsystemFn: async () => ({
        kb: createMockKb(order),
        curateScheduler: {
          start: vi.fn(async () => {
            order.push('curateScheduler.start');
          }),
          schedule: vi.fn(),
          scheduleDeferredCommit: vi.fn(),
          isRunning: () => false,
          stop: vi.fn(async () => {}),
        },
      }),
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => {
        order.push('listenFn');
        return { port: 0, host: '127.0.0.1' };
      },
      closeServerFn: async () => {},
      registerBuiltInProvidersFn: () => {},
    });

    try {
      await coordinator.start();
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          id: NEEDLE_CONSUMER_ID,
          authority: 'corpus',
        }),
      );
      expect(notifyCorpus).toHaveBeenCalledTimes(1);
      expect(order).toContain('retryPendingCorpusPublication');
      expect(order).toContain('withMutationLock:start');
      expect(order).toContain('runEntrySeqUpgradeGuardIfNeeded');
      expect(order).toContain('ensureOramaIndex');
      expect(order).toContain('withMutationLock:end');
      expect(order).toContain('needle.register');
      expect(order).toContain('notifyCorpus');
      expect(order).toContain('curateScheduler.start');
      expect(order).toContain('listenFn');
      expect(order.indexOf('retryPendingCorpusPublication')).toBeLessThan(order.indexOf('withMutationLock:start'));
      expect(order.indexOf('withMutationLock:start')).toBeLessThan(order.indexOf('runEntrySeqUpgradeGuardIfNeeded'));
      expect(order.indexOf('runEntrySeqUpgradeGuardIfNeeded')).toBeLessThan(order.indexOf('ensureOramaIndex'));
      expect(order.indexOf('ensureOramaIndex')).toBeLessThan(order.indexOf('withMutationLock:end'));
      expect(order.indexOf('withMutationLock:end')).toBeLessThan(order.indexOf('needle.register'));
      expect(order.indexOf('needle.register')).toBeLessThan(order.indexOf('notifyCorpus'));
      expect(order.indexOf('needle.register')).toBeLessThan(order.indexOf('curateScheduler.start'));
      expect(order.indexOf('notifyCorpus')).toBeLessThan(order.indexOf('curateScheduler.start'));
      expect(order.indexOf('notifyCorpus')).toBeLessThan(order.indexOf('listenFn'));
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });
});
