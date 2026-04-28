import { describe, expect, it } from 'vitest';

import { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/coordinator/expansion/state.js';
import type { Disposable } from '#src/runtime/ports.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const FIXED_NOW = '2026-04-27T00:00:00.000Z';

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
    const { makeHost } = createTestRuntime();
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state: createMemoryState(),
      manifest: [],
      now: () => FIXED_NOW,
    });

    await expect(lifecycle.recoverOnBoot()).resolves.toBeUndefined();
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
