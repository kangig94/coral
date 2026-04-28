import { describe, expect, it, vi, afterEach } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/coordinator/expansion/state.js';
import { expansionStatusSchema, expansionViewSchema } from '#src/coordinator/expansion/rpc.js';
import { decorateDispose } from '#src/expansion/scope.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const FIXED_NOW = '2026-04-27T00:00:00.000Z';

const FAKE_EMBEDDER_ENTRY = {
  id: 'test-embedder',
  version: '0.0.0',
  specifier: '#tests/fakes/fake-embedder.js',
  metadata: {
    description: 'fake embedder',
    slot: 'kb.embedding',
  },
} as const;

const NEEDLE_ENTRY = {
  id: 'needle',
  version: '0.2.0',
  specifier: '#src/engines/needle/expansion.js',
  metadata: {
    description: 'Needle vector backend',
    onboarding: 'optional' as const,
    slot: 'kb.vector',
  },
} as const;

type MemoryStateStore = Pick<ExpansionStateStore, 'insert' | 'delete' | 'list' | 'get'> & {
  snapshot(): ExpansionStateRow[];
};

function createMemoryState(rows: readonly ExpansionStateRow[] = []): MemoryStateStore {
  const map = new Map(rows.map((row) => [row.id, row]));
  return {
    insert: vi.fn((row: ExpansionStateRow) => {
      map.set(row.id, row);
    }),
    delete: vi.fn((id: string) => {
      map.delete(id);
    }),
    list: vi.fn(() => [...map.values()]),
    get: vi.fn((id: string) => map.get(id)),
    snapshot: () => [...map.values()],
  };
}

function createLifecycleHarness(
  options: {
    manifest?: readonly (typeof FAKE_EMBEDDER_ENTRY)[];
    rows?: readonly ExpansionStateRow[];
  } = {},
) {
  const { kb, makeHost } = createTestRuntime();
  const state = createMemoryState(options.rows);
  const lifecycle = new ExpansionLifecycleService({
    makeHost,
    state: state as unknown as ExpansionStateStore,
    manifest: options.manifest ?? [FAKE_EMBEDDER_ENTRY],
    now: () => FIXED_NOW,
    resolveKbRuntime: () => kb,
  });
  return { kb, state, lifecycle };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExpansionLifecycleService', () => {
  it('equips and unequips a bundled expansion through expansion_state', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness();

    await lifecycle.equip('test-embedder');

    expect(kb.embedding.heldBy).toBe('test-embedder');
    expect(state.snapshot()).toEqual([
      {
        id: 'test-embedder',
        version: '0.0.0',
        installed_at: FIXED_NOW,
      },
    ]);
    expect(lifecycle.info('test-embedder')).toMatchObject({
      id: 'test-embedder',
      version: '0.0.0',
      status: 'active',
    });

    await lifecycle.unequip('test-embedder');

    expect(kb.embedding.heldBy).toBeUndefined();
    expect(state.snapshot()).toEqual([]);
    expect(lifecycle.info('test-embedder')).toMatchObject({
      id: 'test-embedder',
      version: 'unknown',
      status: 'inactive',
    });
  });

  it('rolls back bound state when writing the expansion row fails', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness();
    vi.mocked(state.insert).mockImplementation(() => {
      throw new Error('row write failed');
    });

    await expect(lifecycle.equip('test-embedder')).rejects.toThrow('row write failed');

    expect(kb.embedding.heldBy).toBeUndefined();
    expect(state.snapshot()).toEqual([]);
    expect(lifecycle.has('test-embedder')).toBe(false);
  });

  it('deletes orphan expansion rows during boot recovery and logs a warning', async () => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const { state, lifecycle } = createLifecycleHarness({
      rows: [{ id: 'ghost', version: '1.0.0', installed_at: FIXED_NOW }],
    });

    await lifecycle.recoverOnBoot();

    expect(state.snapshot()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Orphan expansion row 'ghost' deleted; expansion no longer in BUNDLED_EXPANSIONS",
    );
  });

  it('preserves failed recovery rows and reports installed-not-active with lastError', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness({
      manifest: [NEEDLE_ENTRY] as unknown as readonly (typeof FAKE_EMBEDDER_ENTRY)[],
      rows: [{ id: 'needle', version: '0.2.0', installed_at: FIXED_NOW }],
    });

    await lifecycle.recoverOnBoot();

    expect(state.snapshot()).toEqual([{ id: 'needle', version: '0.2.0', installed_at: FIXED_NOW }]);
    expect(kb.vector.heldBy).toBeUndefined();
    expect(lifecycle.info('needle')).toMatchObject({
      id: 'needle',
      version: '0.2.0',
      status: 'installed-not-active',
      lastError: expect.stringContaining("Binding 'kb.embedding'"),
    });
  });

  it('does not auto-load bundled expansions on an empty expansion_state table', async () => {
    const { kb, lifecycle } = createLifecycleHarness();

    await lifecycle.recoverOnBoot();

    expect(kb.embedding.heldBy).toBeUndefined();
    expect(lifecycle.list()).toEqual([]);
  });

  it('runs the expansion-installed dispose hook before tearing down the scope on unequip', async () => {
    const sentinel = `expansion-dispose-${Math.random().toString(36).slice(2)}`;
    const decorateKey = `__decorateDispose_${sentinel}__`;
    const globalState = globalThis as Record<string, unknown>;
    globalState[sentinel] = { fired: 0 };
    globalState[decorateKey] = decorateDispose;
    const source = `
      export default (host) => {
        const slot = globalThis[${JSON.stringify(sentinel)}];
        const decorate = globalThis[${JSON.stringify(decorateKey)}];
        decorate(host.scope, () => { slot.fired += 1; });
        const provider = {
          read: () => ({
            name: 'spy',
            model: 'spy',
            dims: 1,
            normalization: 'l2',
            specId: 'spy:1:l2',
            embedDocuments: async () => [],
            embedQuery: async () => new Float32Array([0]),
          }),
          consumer: {
            id: 'spy-embedder',
            authority: 'journal',
            registrationKind: 'stateless',
          },
        };
        host.registerConsumer(provider.consumer, host.scope);
        host.bind(host.kb.embedding, provider);
      };
    `;
    const specifier = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
    const SPY_ENTRY = {
      id: 'spy-embedder',
      version: '0.0.0',
      specifier,
      metadata: { description: 'dispose spy', slot: 'kb.embedding' },
    } as const;

    try {
      const { lifecycle } = createLifecycleHarness({
        manifest: [SPY_ENTRY] as unknown as readonly (typeof FAKE_EMBEDDER_ENTRY)[],
      });

      await lifecycle.equip('spy-embedder');
      expect((globalState[sentinel] as { fired: number }).fired).toBe(0);

      await lifecycle.unequip('spy-embedder');
      expect((globalState[sentinel] as { fired: number }).fired).toBe(1);
    } finally {
      delete globalState[sentinel];
      delete globalState[decorateKey];
    }
  });

  it('rejects re-equipping a second embedder while another already holds kb.embedding', async () => {
    const SECOND_EMBEDDER = {
      id: 'second-embedder',
      version: '0.0.0',
      specifier: '#tests/fakes/fake-embedder.js',
      metadata: { description: 'second fake embedder', slot: 'kb.embedding' },
    } as const;
    const { kb, lifecycle } = createLifecycleHarness({
      manifest: [FAKE_EMBEDDER_ENTRY, SECOND_EMBEDDER],
    });

    await lifecycle.equip('test-embedder');
    expect(kb.embedding.heldBy).toBe('test-embedder');

    await expect(lifecycle.equip('second-embedder')).rejects.toMatchObject({
      code: 'binding_occupied',
      context: { binding: 'kb.embedding', heldBy: 'test-embedder' },
    });
    // First embedder remains bound; the failed second equip rolled back its scope.
    expect(kb.embedding.heldBy).toBe('test-embedder');
  });

  it('accepts installed-not-active in expansion schemas and allows lastError on the view', () => {
    expect(expansionStatusSchema.parse('installed-not-active')).toBe('installed-not-active');
    expect(
      expansionViewSchema.parse({
        name: 'needle',
        status: 'installed-not-active',
        lastError: 'binding missing',
      }),
    ).toEqual({
      name: 'needle',
      status: 'installed-not-active',
      lastError: 'binding missing',
    });
  });
});
