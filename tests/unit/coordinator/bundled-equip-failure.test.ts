import { describe, expect, it } from 'vitest';

import { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';
import { createExpansionRpc } from '#src/coordinator/expansion/rpc.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/coordinator/expansion/state.js';
import type { Expansion } from '#src/expansion/contract.js';
import { KB_FTS_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { Disposable } from '#src/runtime/ports.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const FIXED_NOW = '2026-04-27T00:00:00.000Z';

const stubFtsRetrieval = {
  search: async () => ({ hits: [], exhausted: true }),
  tokenize: async () => [],
  warnings: () => [],
};

const TEST_BUNDLED_LOADERS: Readonly<Record<string, Expansion>> = {
  'broken-orama': () => {
    throw new Error('boot-equip-boom');
  },
  'broken-secondary': () => {
    throw new Error('second-boom');
  },
  'partial-bundled': (host) => {
    host.bind(KB_FTS_CAPABILITY, {
      read: () => stubFtsRetrieval,
      consumer: {
        id: 'partial-fts',
        kind: 'stateless',
        registrationKind: 'stateless',
      },
    } as never);
    throw new Error('mid-bind failure');
  },
  'success-engine': (host) => {
    host.bind(KB_FTS_CAPABILITY, {
      read: () => stubFtsRetrieval,
      consumer: {
        id: 'success-engine-base',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'base',
        corpusInterest: 'content',
        apply: async () => {},
      },
    } as never);
  },
};

// Specifiers are unused at runtime under the static-dispatch contract, but the
// EngineManifest schema still requires the field. Tests inject behavior via
// `bundledLoaders` keyed by id.
const UNUSED_SPECIFIER = '#unused-test-specifier';

const THROWING_BUNDLED_ENTRY = {
  id: 'broken-orama',
  version: '0.0.0',
  specifier: UNUSED_SPECIFIER,
  tier: 'bundled',
  description: 'bundled engine that throws on boot',
  fills: [KB_FTS_CAPABILITY],
} as const;

const SECOND_THROWING_BUNDLED_ENTRY = {
  id: 'broken-secondary',
  version: '0.0.0',
  specifier: UNUSED_SPECIFIER,
  tier: 'bundled',
  description: 'second bundled engine that throws on boot',
  fills: [KB_VECTOR_CAPABILITY],
} as const;

const PARTIAL_BIND_THEN_THROW_ENTRY = {
  id: 'partial-bundled',
  version: '0.0.0',
  specifier: UNUSED_SPECIFIER,
  tier: 'bundled',
  description: 'bundled engine that binds then throws',
  fills: [KB_FTS_CAPABILITY],
} as const;

const SUCCESS_BUNDLED_ENTRY = {
  id: 'success-engine',
  version: '0.0.0',
  specifier: UNUSED_SPECIFIER,
  tier: 'bundled',
  description: 'bundled engine that binds FTS successfully',
  fills: [KB_FTS_CAPABILITY],
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

function heldBy(kb: KbRuntime, name: typeof KB_FTS_CAPABILITY | typeof KB_VECTOR_CAPABILITY): string | undefined {
  return kb.capabilityRegistry.runtimeView().status(name)?.heldBy;
}

describe('bundled-engine equip failure surfaces through recoverOnBoot', () => {
  it('aggregates a single failure into a thrown Error', async () => {
    const { makeHost } = createTestRuntime();
    const state = createMemoryState();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state,
      bundledLoaders: TEST_BUNDLED_LOADERS,
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
      bundledLoaders: TEST_BUNDLED_LOADERS,
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
      bundledLoaders: TEST_BUNDLED_LOADERS,
      manifest: [SUCCESS_BUNDLED_ENTRY],
      now: () => FIXED_NOW,
      resolveKbRuntime: () => kb,
    });

    await expect(lifecycle.recoverOnBoot()).resolves.toBeUndefined();
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('success-engine');
    expect(lifecycle.list()).toMatchObject([
      {
        id: 'success-engine',
        version: '0.0.0',
        tier: 'bundled',
        status: 'active',
      },
    ]);
    await expect(createExpansionRpc(lifecycle).listExpansion({})).resolves.toMatchObject({
      expansions: [{ name: 'success-engine', tier: 'bundled', status: 'equipped' }],
    });
    expect(state.list().filter((row) => row.id === 'success-engine')).toEqual([]);
  });

  it('rolls back a partial bundled bind and does not append the failed scope', async () => {
    const { kb, makeHost } = createTestRuntime();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state: createMemoryState(),
      bundledLoaders: TEST_BUNDLED_LOADERS,
      manifest: [PARTIAL_BIND_THEN_THROW_ENTRY],
      now: () => FIXED_NOW,
      resolveKbRuntime: () => kb,
    });

    const fallback = await lifecycle.applyBundledFallback();

    expect(fallback.equipped).toEqual([]);
    expect(fallback.failed.size).toBe(1);
    expect(fallback.failed.get('partial-bundled')?.message).toBe('mid-bind failure');
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBeUndefined();
    expect(lifecycleScopes(lifecycle).get('partial-bundled')).toBeUndefined();
    expect(lifecycle.isActive('partial-bundled')).toBe(false);
  });
});
