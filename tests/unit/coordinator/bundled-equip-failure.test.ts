import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';
import { createExpansionRpc } from '#src/coordinator/expansion/rpc.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/coordinator/expansion/state.js';
import type { Disposable } from '#src/runtime/ports.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const FIXED_NOW = '2026-04-27T00:00:00.000Z';

function javascriptDataUrl(source: string): string {
  return `data:application/javascript,${encodeURIComponent(source)}`;
}

const THROWING_BUNDLED_SOURCE = `
  export default () => {
    throw new Error('boot-equip-boom');
  };
`;
const THROWING_BUNDLED_SPECIFIER = `data:text/javascript;base64,${Buffer.from(THROWING_BUNDLED_SOURCE, 'utf8').toString(
  'base64',
)}`;

const SECOND_THROWING_SOURCE = `
  export default () => {
    throw new Error('second-boom');
  };
`;
const SECOND_THROWING_SPECIFIER = `data:text/javascript;base64,${Buffer.from(SECOND_THROWING_SOURCE, 'utf8').toString(
  'base64',
)}`;

const PARTIAL_BIND_THEN_THROW_SOURCE = `
  export default (host) => {
    host.bind(host.kb.fts, {
      read: () => ({
        search: async () => ({ hits: [], exhausted: true }),
        tokenize: () => [],
        warnings: () => [],
      }),
      consumer: {
        id: 'partial-fts',
        authority: 'journal',
      },
    });
    throw new Error('mid-bind failure');
  };
`;
const PARTIAL_BIND_THEN_THROW_SPECIFIER = `data:text/javascript;base64,${Buffer.from(
  PARTIAL_BIND_THEN_THROW_SOURCE,
  'utf8',
).toString('base64')}`;

const SUCCESS_BUNDLED_SOURCE = `
  const stubFtsRetrieval = {
    search: async () => ({ hits: [], exhausted: true }),
    tokenize: () => [],
    warnings: () => [],
  };

  export default (host) => {
    const ftsBacked = {
      read: () => stubFtsRetrieval,
      consumer: {
        id: 'success-engine-base',
        authority: 'corpus',
        corpusInterest: 'content',
        apply: async () => {},
      },
    };
    host.bind(host.kb.fts, ftsBacked);
  };
`;
const SUCCESS_BUNDLED_SPECIFIER = javascriptDataUrl(SUCCESS_BUNDLED_SOURCE);

const THROWING_BUNDLED_ENTRY = {
  id: 'broken-orama',
  version: '0.0.0',
  specifier: THROWING_BUNDLED_SPECIFIER,
  tier: 'bundled',
  description: 'bundled engine that throws on boot',
  fills: ['kb.fts'],
} as const;

const SECOND_THROWING_BUNDLED_ENTRY = {
  id: 'broken-secondary',
  version: '0.0.0',
  specifier: SECOND_THROWING_SPECIFIER,
  tier: 'bundled',
  description: 'second bundled engine that throws on boot',
  fills: ['kb.vector'],
} as const;

const PARTIAL_BIND_THEN_THROW_ENTRY = {
  id: 'partial-bundled',
  version: '0.0.0',
  specifier: PARTIAL_BIND_THEN_THROW_SPECIFIER,
  tier: 'bundled',
  description: 'bundled engine that binds then throws',
  fills: ['kb.fts'],
} as const;

const SUCCESS_BUNDLED_ENTRY = {
  id: 'success-engine',
  version: '0.0.0',
  specifier: SUCCESS_BUNDLED_SPECIFIER,
  tier: 'bundled',
  description: 'bundled engine that binds FTS successfully',
  fills: ['kb.fts'],
} as const;

function createMemoryState(rows: readonly ExpansionStateRow[] = []): ExpansionStateStore {
  const map = new Map(rows.map((row) => [row.id, row]));
  return {
    insert: (row: ExpansionStateRow) => {
      map.set(row.id, row);
    },
    delete: (id: string) => {
      map.delete(id);
    },
    list: () => [...map.values()],
    get: (id: string) => map.get(id),
  } as ExpansionStateStore;
}

function lifecycleScopes(lifecycle: ExpansionLifecycleService): Map<string, Disposable[]> {
  return (lifecycle as unknown as { scopes: Map<string, Disposable[]> }).scopes;
}

describe('bundled-engine equip failure surfaces through recoverOnBoot', () => {
  it('aggregates a single failure into a thrown Error', async () => {
    const { makeHost } = createTestRuntime();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state: createMemoryState(),
      manifest: [THROWING_BUNDLED_ENTRY],
      now: () => FIXED_NOW,
    });

    await expect(lifecycle.recoverOnBoot()).rejects.toThrow(
      /Bundled-engine equip failed: broken-orama: boot-equip-boom/,
    );
  });

  it('joins multiple bundled-engine failures into a single aggregated message', async () => {
    const { makeHost } = createTestRuntime();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state: createMemoryState(),
      manifest: [THROWING_BUNDLED_ENTRY, SECOND_THROWING_BUNDLED_ENTRY],
      now: () => FIXED_NOW,
    });

    await expect(lifecycle.recoverOnBoot()).rejects.toThrow(
      /Bundled-engine equip failed: broken-orama: boot-equip-boom; broken-secondary: second-boom/,
    );
  });

  it('does not throw when all bundled engines equip successfully', async () => {
    const { kb, makeHost } = createTestRuntime();
    const state = createMemoryState();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state,
      manifest: [SUCCESS_BUNDLED_ENTRY],
      now: () => FIXED_NOW,
      resolveKbRuntime: () => kb,
    });

    await expect(lifecycle.recoverOnBoot()).resolves.toBeUndefined();
    expect(kb.fts.heldBy).toBe('success-engine');
    expect(lifecycle.list()).toEqual([
      {
        id: 'success-engine',
        version: '0.0.0',
        tier: 'bundled',
        status: 'active',
      },
    ]);
    await expect(createExpansionRpc(lifecycle).listExpansion({})).resolves.toEqual({
      expansions: [{ name: 'success-engine', tier: 'bundled', status: 'equipped' }],
    });
    expect(state.list().filter((row) => row.id === 'success-engine')).toEqual([]);
  });

  it('rolls back a partial bundled bind and does not append the failed scope', async () => {
    const { kb, makeHost } = createTestRuntime();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state: createMemoryState(),
      manifest: [PARTIAL_BIND_THEN_THROW_ENTRY],
      now: () => FIXED_NOW,
      resolveKbRuntime: () => kb,
    });

    const fallback = await lifecycle.applyBundledFallback();

    expect(fallback.equipped).toEqual([]);
    expect(fallback.failed.size).toBe(1);
    expect(fallback.failed.get('partial-bundled')?.message).toBe('mid-bind failure');
    expect(kb.fts.heldBy).toBeUndefined();
    expect(lifecycleScopes(lifecycle).get('partial-bundled')).toBeUndefined();
    expect(lifecycle.isActive('partial-bundled')).toBe(false);
  });
});

describe('coordinator degraded-KB propagation for bundled fallback failures', () => {
  it('sets kb init error and keeps non-KB IPC online when recoverOnBoot fallback throws', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { kb, makeHost, runtime } = createTestRuntime();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state: createMemoryState(),
      manifest: [THROWING_BUNDLED_ENTRY],
      now: () => FIXED_NOW,
      resolveKbRuntime: () => kb,
    });
    const core = createCoordinatorCore({
      runtime,
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'test-instance',
        token: 'test-token',
        now: () => 1_000,
        log: () => {},
      },
      expansionLifecycleService: lifecycle,
      createKbSubsystemFn: async (): Promise<never> => {
        await lifecycle.recoverOnBoot();
        throw new Error('recoverOnBoot unexpectedly resolved');
      },
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
      acquireLockFn: async () => {},
      writeBackendInfoFn: () => {},
      removeBackendInfoIfOwnerFn: () => {},
      removeLockIfOwnerFn: () => {},
      cleanupStaleJobsFn: () => {},
      markJobsAsErrorFn: () => {},
      terminateAllFn: () => {},
      registerBuiltInProvidersFn: () => {},
      recoverPersistedDiscussFn: async () => [],
      runStartupRecoveryFn: async () => [],
    });

    try {
      const info = await core.lifecycleController.start();
      const initError = core.runtimeState.getKbInitError();

      expect(core.runtimeState.getLifecycle()).toBe('running');
      expect(initError).toContain('broken-orama');
      expect(initError).toContain('boot-equip-boom');
      expect(core.runtimeState.getKbSubsystem()).toBeNull();

      const health = await requestIpcMethod<Record<string, unknown>>(
        info.socketPath,
        'transport.health',
        undefined,
        { timeoutMs: 1_000 },
      );
      expect(health.subsystems).toMatchObject({
        kb: 'unavailable',
        kbError: initError,
      });

      const kbSearch = await requestIpcMethod<Record<string, unknown>>(
        info.socketPath,
        'kb.entries.search',
        { q: 'hello' },
        { timeoutMs: 1_000 },
      );
      expect(kbSearch).toMatchObject({
        code: 'kb_unavailable',
        message: 'Knowledge base is not available. Check backend health for details.',
      });

      await expect(requestIpcMethod(info.socketPath, 'jobs.list', { all: true }, { timeoutMs: 1_000 })).resolves.toEqual({
        jobs: [],
      });
    } finally {
      if (core.runtimeState.getLifecycle() !== 'stopped') {
        await core.lifecycleController.shutdown('test-cleanup');
        await core.lifecycleController.waitForShutdown();
      }
      stderrSpy.mockRestore();
    }
  });
});
