import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '../../runtime/real.js';
import { jobsReconcile } from '../../jobs/api.js';
import { ConsumerDriver } from '../consumer-driver.js';
import { createCoordinatorServer } from '../coordinator.js';
import type { KbCorpusSnapshot as CorpusSnapshot } from '../../kb/contracts.js';
import type { VectorRetrieval } from '../../kb/search/contract.js';
import { workflowRecover } from '../../workflow/api.js';

const tempRoots: string[] = [];
const EMPTY_CORPUS_SNAPSHOT: CorpusSnapshot = {
  snapshotId: '',
  contentSeq: 0,
  metadataSeq: 0,
  contentManifestHash: '',
  metadataManifestHash: '',
};

function createMockKb(order?: string[]) {
  const vectorSurface: VectorRetrieval = {
    search: vi.fn(async () => ({ hits: [] })),
  };

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
    getEquipmentView: vi.fn(() => ({
      retrieval: vectorSurface,
      snapshotId: null,
      contentSeq: 0,
      contentManifestHash: null,
    })),
    getActiveVectorSurface: vi.fn(() => vectorSurface),
    getBaseRetrievalSurface: vi.fn(() => vectorSurface),
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
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
      expect(waitFreshUntil).toHaveBeenNthCalledWith(1, expect.any(Number), 'jobs', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(2, expect.any(Number), 'sessions', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(3, expect.any(Number), 'discuss', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(4, expect.any(Number), 'workflow', expect.any(Number));
      expect(runStartup).toHaveBeenCalledTimes(1);
      expect(order.indexOf('jobsReconcile.runStartup')).toBeGreaterThan(order.lastIndexOf('waitFreshUntil:resolved'));
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });

  it('publishes backend info only after Journal startup recovery completes', async () => {
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
    const journalConsumerIds = new Set(['jobs', 'sessions', 'discuss', 'workflow']);
    const observedJournalConsumers = new Set<string>();
    const originalRegister = ConsumerDriver.prototype.register;
    const register = vi.spyOn(ConsumerDriver.prototype, 'register').mockImplementation(function (
      this: ConsumerDriver,
      reg,
    ) {
      const result = originalRegister.call(this, reg);
      if (reg.authority === 'journal' && journalConsumerIds.has(reg.id)) {
        order.push(`register:${reg.id}`);
        observedJournalConsumers.add(reg.id);
        if (observedJournalConsumers.size === journalConsumerIds.size) {
          order.push('registerJournalConsumers');
        }
      }
      return result;
    });
    const waitFreshUntil = vi.spyOn(ConsumerDriver.prototype, 'waitFreshUntil').mockImplementation(async (
      _target,
      consumerId,
    ) => {
      order.push(`waitFreshUntil:${consumerId}`);
    });
    const runStartup = vi.spyOn(jobsReconcile, 'runStartup').mockImplementation(async () => {
      order.push('jobsReconcile.runStartup');
    });
    const resumeAll = vi.spyOn(workflowRecover, 'resumeAll').mockImplementation(async () => {
      order.push('workflowRecover.resumeAll');
      return [];
    });
    const recoverPersistedDiscussFn = vi.fn(async () => {
      order.push('recoverPersistedDiscussFn');
      return [];
    });
    const writeBackendInfoFn = vi.fn(() => {
      order.push('writeBackendInfoFn');
    });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      createKbSubsystemFn: async () => {
        const kbSubsystem = {
          kb: createMockKb(),
          curateScheduler: {
            start: vi.fn(async () => {}),
            schedule: vi.fn(),
            scheduleDeferredCommit: vi.fn(),
            isRunning: () => false,
            stop: vi.fn(async () => {}),
          },
        };
        order.push('kbSubsystem ready');
        return kbSubsystem;
      },
      recoverPersistedDiscussFn,
      writeBackendInfoFn,
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => {
        order.push('listenFn (bind)');
        return { port: 0, host: '127.0.0.1' };
      },
      closeServerFn: async () => {},
      registerBuiltInProvidersFn: () => {},
    });

    try {
      await coordinator.start();
      order.push("setLifecycle('running')");

      const waitFreshOrder = [
        order.indexOf('waitFreshUntil:jobs'),
        order.indexOf('waitFreshUntil:sessions'),
        order.indexOf('waitFreshUntil:discuss'),
        order.indexOf('waitFreshUntil:workflow'),
      ];

      expect(coordinator.getLifecycle()).toBe('running');
      expect(waitFreshUntil).toHaveBeenCalledTimes(4);
      expect(waitFreshUntil).toHaveBeenNthCalledWith(1, expect.any(Number), 'jobs', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(2, expect.any(Number), 'sessions', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(3, expect.any(Number), 'discuss', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(4, expect.any(Number), 'workflow', expect.any(Number));
      expect(order.indexOf('kbSubsystem ready')).toBeLessThan(order.indexOf('listenFn (bind)'));
      expect(order.indexOf('listenFn (bind)')).toBeLessThan(order.indexOf('registerJournalConsumers'));
      expect(order.indexOf('registerJournalConsumers')).toBeLessThan(Math.min(...waitFreshOrder));
      expect(Math.max(...waitFreshOrder)).toBeLessThan(order.indexOf('jobsReconcile.runStartup'));
      expect(order.indexOf('jobsReconcile.runStartup')).toBeLessThan(order.indexOf('recoverPersistedDiscussFn'));
      expect(order.indexOf('recoverPersistedDiscussFn')).toBeLessThan(order.indexOf('workflowRecover.resumeAll'));
      expect(order.indexOf('workflowRecover.resumeAll')).toBeLessThan(order.indexOf('writeBackendInfoFn'));
      expect(order.indexOf('writeBackendInfoFn')).toBeLessThan(order.indexOf("setLifecycle('running')"));
      expect(writeBackendInfoFn).toHaveBeenCalledTimes(1);
    } finally {
      register.mockRestore();
      waitFreshUntil.mockRestore();
      runStartup.mockRestore();
      resumeAll.mockRestore();
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
    const register = vi.spyOn(ConsumerDriver.prototype, 'register');
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
      expect(notifyCorpus).toHaveBeenCalledTimes(1);
      expect(register.mock.calls.some(([reg]) => reg.authority === 'corpus')).toBe(false);
      expect(order).toContain('retryPendingCorpusPublication');
      expect(order).toContain('withMutationLock:start');
      expect(order).toContain('runEntrySeqUpgradeGuardIfNeeded');
      expect(order).toContain('ensureOramaIndex');
      expect(order).toContain('withMutationLock:end');
      expect(order).toContain('notifyCorpus');
      expect(order).toContain('curateScheduler.start');
      expect(order).toContain('listenFn');
      expect(order.indexOf('retryPendingCorpusPublication')).toBeLessThan(order.indexOf('withMutationLock:start'));
      expect(order.indexOf('withMutationLock:start')).toBeLessThan(order.indexOf('runEntrySeqUpgradeGuardIfNeeded'));
      expect(order.indexOf('runEntrySeqUpgradeGuardIfNeeded')).toBeLessThan(order.indexOf('ensureOramaIndex'));
      expect(order.indexOf('ensureOramaIndex')).toBeLessThan(order.indexOf('withMutationLock:end'));
      expect(order.indexOf('withMutationLock:end')).toBeLessThan(order.indexOf('notifyCorpus'));
      expect(order.indexOf('notifyCorpus')).toBeLessThan(order.indexOf('curateScheduler.start'));
      expect(order.indexOf('notifyCorpus')).toBeLessThan(order.indexOf('listenFn'));
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });
});
