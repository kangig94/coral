import { describe, expect, it, vi } from 'vitest';

import { ExpansionLifecycleService } from '#src/kb-daemon/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/kb-daemon/expansion/state.js';
import { BUNDLED_ENGINES } from '#src/expansion/bundled.js';
import type { Expansion } from '#src/expansion/contract.js';
import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import { initializeCapabilityCatalog } from '#src/expansion/manifest/fills-validation.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  KB_FTS_CAPABILITY,
} from '#src/kb/capability/constants.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';
import {
  DUMMY_CACHE_CAPABILITY,
  dummyCapabilityConsumerManifest,
  dummyCapabilityProviderManifest,
} from '#tests/fixtures/dummy-capability-engine/manifest.js';

const FIXED_NOW = '2026-05-03T00:00:00.000Z';

const ORAMA_ENTRY = BUNDLED_ENGINES.find((entry) => entry.id === 'orama');
if (ORAMA_ENTRY === undefined) {
  throw new Error('test requires bundled orama manifest');
}

const TEST_BUNDLED_LOADERS: Readonly<Record<string, Expansion>> = {
  [ORAMA_ENTRY.id]: (host) => {
    host.bind(KB_FTS_CAPABILITY, {
      read: () => ({
        search: async () => ({ hits: [], exhausted: true }),
        tokenize: async () => [],
        warnings: () => [],
      }),
      consumer: {
        id: 'orama-test',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'base',
        corpusInterest: 'content',
        apply: async () => {},
      },
    } as never);
  },
};

type MemoryStateStore = Pick<ExpansionStateStore, 'insert' | 'delete' | 'list' | 'get'> & {
  snapshot(): ExpansionStateRow[];
};

function createMemoryState(): MemoryStateStore {
  const rows = new Map<string, ExpansionStateRow>();
  return {
    insert: vi.fn((row: ExpansionStateRow) => {
      rows.set(row.id, row);
    }),
    delete: vi.fn((id: string) => {
      rows.delete(id);
    }),
    list: vi.fn(() => [...rows.values()]),
    get: vi.fn((id: string) => rows.get(id)),
    snapshot: () => [...rows.values()],
  };
}

function createHarness() {
  const { kb, makeHost } = createTestRuntime();
  const state = createMemoryState();
  const manifestCatalog = createExpansionManifestCatalog({ staticManifests: [ORAMA_ENTRY!] });
  manifestCatalog.upsertInstalledEntry(dummyCapabilityProviderManifest);
  manifestCatalog.upsertInstalledEntry(dummyCapabilityConsumerManifest);
  initializeCapabilityCatalog(kb.capabilityRegistry, manifestCatalog.listManifests(), [
    BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
    BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
    BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  ]);
  const lifecycle = new ExpansionLifecycleService({
    makeHost,
    state: state as unknown as ExpansionStateStore,
    manifestCatalog,
    bundledLoaders: TEST_BUNDLED_LOADERS,
    now: () => FIXED_NOW,
    resolveKbRuntime: () => kb,
  });

  return { kb, state, lifecycle };
}

describe('external capability registration integration', () => {
  it('declares, binds, requires, blocks dependent removal, and unregisters external capabilities', async () => {
    const { kb, state, lifecycle } = createHarness();

    expect(kb.capabilityRegistry.catalogView().hasDescriptor(DUMMY_CACHE_CAPABILITY)).toBe(true);
    expect(kb.capabilityRegistry.runtimeView().status(DUMMY_CACHE_CAPABILITY)).toMatchObject({
      declared: true,
      bound: false,
      declaredByManifest: 'dummy-capability-provider',
    });

    await lifecycle.equip('dummy-capability-provider');
    expect(kb.capabilityRegistry.runtimeView().status(DUMMY_CACHE_CAPABILITY)).toMatchObject({
      bound: true,
      heldBy: 'dummy-capability-provider',
    });

    await lifecycle.unequip('dummy-capability-provider');
    expect(kb.capabilityRegistry.runtimeView().status(DUMMY_CACHE_CAPABILITY)).toMatchObject({
      declared: true,
      bound: false,
      declaredByManifest: 'dummy-capability-provider',
    });

    await lifecycle.equip('dummy-capability-provider');
    await lifecycle.equip('dummy-capability-consumer');

    const immutable = await lifecycle.removeExpansionCatalog(ORAMA_ENTRY.id);
    expect(immutable).toEqual({ status: 'immutable' });
    expect(kb.capabilityRegistry.catalogView().hasDescriptor(KB_FTS_CAPABILITY)).toBe(true);

    const blocked = await lifecycle.removeExpansionCatalog('dummy-capability-provider');
    expect(blocked).toMatchObject({
      status: 'blocked',
      target: 'dummy-capability-provider',
      capabilities: [
        {
          capability: DUMMY_CACHE_CAPABILITY,
          dependents: [
            {
              expansion: 'dummy-capability-consumer',
              edgeKind: 'read',
              source: 'onboarding',
              state: 'active',
            },
          ],
        },
      ],
      dependents: [
        {
          capability: DUMMY_CACHE_CAPABILITY,
          expansion: 'dummy-capability-consumer',
          edgeKind: 'read',
          source: 'onboarding',
          state: 'active',
        },
      ],
    });

    await expect(lifecycle.removeExpansionCatalog('dummy-capability-consumer')).resolves.toEqual({ status: 'removed' });
    await expect(lifecycle.removeExpansionCatalog('dummy-capability-provider')).resolves.toEqual({ status: 'removed' });

    expect(kb.capabilityRegistry.catalogView().hasDescriptor(DUMMY_CACHE_CAPABILITY)).toBe(false);
    expect(kb.capabilityRegistry.runtimeView().status(DUMMY_CACHE_CAPABILITY)).toBeUndefined();
    expect(state.snapshot()).toEqual([]);
  });
});
