import type * as MockedFakeEmbedderModule from '#tests/fakes/fake-embedder.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpansionLifecycleService } from '#src/kb-daemon/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/kb-daemon/expansion/state.js';
import type { EngineManifest } from '#src/expansion/contract.js';
import { KB_EMBEDDING_CAPABILITY } from '#src/kb/capability/constants.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';
import { createDeferred } from '#tools/testing/deferred.js';

const importGate = vi.hoisted(() => ({ beforeBind: async () => {} }));
vi.mock('#tests/fakes/fake-embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MockedFakeEmbedderModule>();
  return {
    default: async (host: Parameters<typeof actual.default>[0]) => {
      await importGate.beforeBind();
      await actual.default(host);
    },
  };
});

afterEach(() => {
  importGate.beforeBind = async () => {};
});

const ENTRY: EngineManifest = {
  id: 'test-embedder',
  version: '0.0.0',
  specifier: '#tests/fakes/fake-embedder.js',
  tier: 'installed',
  description: 'fake embedder',
  fills: [KB_EMBEDDING_CAPABILITY],
};

function createLifecycle(manifest = ENTRY, getLifecyclePhase = (): 'running' | 'draining' => 'running') {
  const { kb, makeHost } = createTestRuntime();
  const rows = new Map<string, ExpansionStateRow>();
  const state = {
    insert: vi.fn((row: ExpansionStateRow) => {
      rows.set(row.id, row);
    }),
    delete: (id: string) => {
      rows.delete(id);
    },
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id),
  };
  const lifecycle = new ExpansionLifecycleService({
    makeHost,
    state: state as unknown as ExpansionStateStore,
    manifest: [manifest],
    bundledLoaders: {},
    now: () => '2026-04-27T00:00:00.000Z',
    resolveKbRuntime: () => kb,
    getLifecyclePhase,
  });
  return { kb, state, lifecycle };
}

describe('ExpansionLifecycleService', () => {
  it('refuses an unsafe package id before loading it', async () => {
    const { lifecycle, state } = createLifecycle({ ...ENTRY, id: '../escape' });
    await expect(lifecycle.equip('../escape')).rejects.toThrow(/is unsafe/u);
    expect(state.list()).toEqual([]);
  });

  it('rolls back the binding when the state write fails', async () => {
    const { kb, state, lifecycle } = createLifecycle();
    state.insert.mockImplementation(() => {
      throw new Error('row write failed');
    });
    await expect(lifecycle.equip(ENTRY.id)).rejects.toThrow('row write failed');
    expect(kb.capabilityRegistry.runtimeView().status(KB_EMBEDDING_CAPABILITY)?.heldBy).toBeUndefined();
    expect(state.list()).toEqual([]);
    expect(lifecycle.has(ENTRY.id)).toBe(false);
  });

  it('disposes an in-flight import when shutdown overlaps', async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    importGate.beforeBind = async () => {
      started.resolve();
      await release.promise;
    };
    let phase: 'running' | 'draining' = 'running';
    const { kb, state, lifecycle } = createLifecycle(ENTRY, () => phase);
    const equip = lifecycle.equip(ENTRY.id);
    await started.promise;
    phase = 'draining';
    const shutdown = lifecycle.shutdownActiveExpansions();
    release.resolve();
    await equip;
    await shutdown;
    expect(kb.capabilityRegistry.runtimeView().status(KB_EMBEDDING_CAPABILITY)?.heldBy).toBeUndefined();
    expect(state.get(ENTRY.id)?.id).toBe(ENTRY.id);
    expect(lifecycle.isActive(ENTRY.id)).toBe(false);
  });
});
