import { describe, expect, it, vi, afterEach } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/coordinator/expansion/state.js';
import { expansionStatusSchema, expansionViewSchema } from '#src/coordinator/expansion/rpc.js';
import { decorateDispose } from '#src/expansion/scope.js';
import { BUNDLED_ENGINES } from '#src/expansion/bundled.js';
import type { EngineManifest } from '#src/expansion/contract.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import type { Disposable } from '#src/runtime/ports.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const FIXED_NOW = '2026-04-27T00:00:00.000Z';

function javascriptDataUrl(source: string): string {
  return `data:application/javascript,${encodeURIComponent(source)}`;
}

const SYNTHETIC_EMBEDDER_SOURCE = `
  export default (host) => {
    host.bind(host.kb.embedding, {
      read: () => ({
        name: 'synthetic-embedding',
        model: 'synthetic',
        dims: 1,
        normalization: 'l2',
        specId: 'synthetic:1:l2',
        embedDocuments: async (texts) => texts.map(() => new Float32Array([0])),
        embedQuery: async () => new Float32Array([0]),
      }),
      consumer: {
        id: 'gemini-embedding',
        authority: 'journal',
      },
    });
  };
`;

const SYNTHETIC_VECTOR_SOURCE = `
  export default (host) => {
    host.require(host.kb.embedding);
    host.bind(host.kb.vector, {
      read: () => ({
        search: async () => ({ hits: [] }),
      }),
      consumer: {
        id: 'needle-vector',
        authority: 'corpus',
        corpusInterest: 'content',
        apply: async () => {},
      },
    });
  };
`;

const SYNTHETIC_FTS_SOURCE = `
  export default (host) => {
    host.bind(host.kb.fts, {
      read: () => ({
        search: async () => ({ hits: [], exhausted: true }),
        tokenize: () => [],
        warnings: () => [],
      }),
      consumer: {
        id: 'orama-fts-only-base',
        authority: 'corpus',
        corpusInterest: 'content',
        apply: async () => {},
      },
    });
  };
`;

const SYNTHETIC_BUNDLED_VECTOR_SOURCE = `
  export default (host) => {
    host.bind(host.kb.vector, {
      read: () => ({
        search: async () => ({ hits: [] }),
      }),
      consumer: {
        id: 'bundled-vector-base',
        authority: 'corpus',
        corpusInterest: 'content',
        apply: async () => {},
      },
    });
  };
`;

const FAKE_EMBEDDER_ENTRY = {
  id: 'test-embedder',
  version: '0.0.0',
  specifier: '#tests/fakes/fake-embedder.js',
  tier: 'installed',
  description: 'fake embedder',
  fills: ['kb.embedding'],
} as const;

const NEEDLE_ENTRY = {
  id: 'needle',
  version: '0.2.0',
  specifier: '#src/engines/needle/expansion.js',
  tier: 'installed',
  description: 'Needle vector backend',
  onboarding: [{ kind: 'require-binding', binding: 'kb.embedding' }],
  fills: ['kb.vector'],
} as const;

const GEMINI_SYNTHETIC_ENTRY = {
  id: 'gemini',
  version: '0.0.0',
  specifier: javascriptDataUrl(SYNTHETIC_EMBEDDER_SOURCE),
  tier: 'installed',
  description: 'synthetic installed embedder',
  fills: ['kb.embedding'],
} as const;

const NEEDLE_SYNTHETIC_ENTRY = {
  id: 'needle',
  version: '0.0.0',
  specifier: javascriptDataUrl(SYNTHETIC_VECTOR_SOURCE),
  tier: 'installed',
  description: 'synthetic installed vector backend',
  onboarding: [{ kind: 'require-binding', binding: 'kb.embedding' }],
  fills: ['kb.vector'],
} as const;

const BUNDLED_FTS_SYNTHETIC_ENTRY = {
  id: 'orama-fts-only',
  version: '0.0.0',
  specifier: javascriptDataUrl(SYNTHETIC_FTS_SOURCE),
  tier: 'bundled',
  description: 'synthetic bundled FTS backend',
  fills: ['kb.fts'],
} as const;

const BUNDLED_VECTOR_SYNTHETIC_ENTRY = {
  id: 'bundled-vector',
  version: '0.0.0',
  specifier: javascriptDataUrl(SYNTHETIC_BUNDLED_VECTOR_SOURCE),
  tier: 'bundled',
  description: 'synthetic bundled vector backend',
  fills: ['kb.vector'],
} as const;

const ORAMA_ENTRY = BUNDLED_ENGINES.find((entry) => entry.id === 'orama');
if (ORAMA_ENTRY === undefined) {
  throw new Error('test requires the bundled FTS engine entry');
}

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
    manifest?: readonly EngineManifest[];
    rows?: readonly ExpansionStateRow[];
    getLifecyclePhase?: () => 'starting' | 'running' | 'draining' | 'stopped';
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
    ...(options.getLifecyclePhase === undefined ? {} : { getLifecyclePhase: options.getLifecyclePhase }),
  });
  return { kb, state, lifecycle };
}

function lifecycleScopes(lifecycle: ExpansionLifecycleService): Map<string, Disposable[]> {
  return (lifecycle as unknown as { scopes: Map<string, Disposable[]> }).scopes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExpansionLifecycleService', () => {
  it('equips and unequips an installed expansion through expansion_state', async () => {
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
    expect(warn).toHaveBeenCalledWith("Orphan expansion row 'ghost' deleted; expansion no longer in BUNDLED_ENGINES");
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

  it('skips bundled fallback when declared fills are already held', async () => {
    const { kb, lifecycle } = createLifecycleHarness({
      manifest: [FAKE_EMBEDDER_ENTRY, ORAMA_ENTRY],
    });

    const first = await lifecycle.applyBundledFallback();

    expect(first.equipped).toEqual(['orama']);
    expect(first.failed.size).toBe(0);
    expect(kb.fts.heldBy).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);

    const second = await lifecycle.applyBundledFallback();

    expect(second.equipped).toEqual([]);
    expect(second.failed.size).toBe(0);
    expect(kb.fts.heldBy).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);

    await lifecycle.equip('test-embedder');
    expect(kb.embedding.heldBy).toBe('test-embedder');

    await lifecycle.unequip('test-embedder');
    expect(kb.embedding.heldBy).toBeUndefined();
    expect(kb.fts.heldBy).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);

    const afterUnrelatedUnequip = await lifecycle.applyBundledFallback();

    expect(afterUnrelatedUnequip.equipped).toEqual([]);
    expect(afterUnrelatedUnequip.failed.size).toBe(0);
    expect(kb.fts.heldBy).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);
  });

  it('rejects unequipping a binding provider required by an active engine', async () => {
    const expected = documentedCoralSetupError('binding_required_by_active_engine', {
      binding: 'kb.embedding',
      requiredBy: 'needle',
    });
    const { kb, lifecycle } = createLifecycleHarness({
      manifest: [GEMINI_SYNTHETIC_ENTRY, NEEDLE_SYNTHETIC_ENTRY],
    });

    await lifecycle.equip('gemini');
    await lifecycle.equip('needle');

    await expect(lifecycle.unequip('gemini')).rejects.toMatchObject({
      code: expected.code,
      message: expected.message,
      context: expected.context,
    });
    expect(kb.embedding.heldBy).toBe('gemini');
    expect(kb.vector.heldBy).toBe('needle');
  });

  it('re-runs bundled fallback after unequipping an installed engine and refills an empty slot', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness({
      manifest: [
        GEMINI_SYNTHETIC_ENTRY,
        NEEDLE_SYNTHETIC_ENTRY,
        BUNDLED_FTS_SYNTHETIC_ENTRY,
        BUNDLED_VECTOR_SYNTHETIC_ENTRY,
      ],
      rows: [
        { id: 'gemini', version: '0.0.0', installed_at: FIXED_NOW },
        { id: 'needle', version: '0.0.0', installed_at: FIXED_NOW },
      ],
    });

    await lifecycle.recoverOnBoot();

    expect(kb.embedding.heldBy).toBe('gemini');
    expect(kb.vector.heldBy).toBe('needle');
    expect(kb.fts.heldBy).toBe('orama-fts-only');
    expect(lifecycleScopes(lifecycle).get('bundled-vector')).toBeUndefined();

    await lifecycle.unequip('needle');

    expect(kb.embedding.heldBy).toBe('gemini');
    expect(kb.vector.heldBy).toBe('bundled-vector');
    expect(kb.fts.heldBy).toBe('orama-fts-only');
    expect(lifecycleScopes(lifecycle).get('bundled-vector')).toHaveLength(1);
    expect(state.snapshot()).toEqual([{ id: 'gemini', version: '0.0.0', installed_at: FIXED_NOW }]);
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
      tier: 'installed',
      description: 'dispose spy',
      fills: ['kb.embedding'],
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
      tier: 'installed',
      description: 'second fake embedder',
      fills: ['kb.embedding'],
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
        tier: 'installed',
        status: 'installed-not-active',
        lastError: 'binding missing',
      }),
    ).toEqual({
      name: 'needle',
      tier: 'installed',
      status: 'installed-not-active',
      lastError: 'binding missing',
    });
  });

  // G5: shutdown during equip — phase flips to draining while
  // `await module.default(host)` is running. The equip must dispose the bound
  // resource and surface a structured aborted error so the partial install is
  // not orphaned outside `shutdownActiveExpansions`'s view.
  it('aborts equip when the coordinator transitions to draining mid-import', async () => {
    let phase: 'starting' | 'running' | 'draining' | 'stopped' = 'running';
    const gateKey = `__cluster_M_gate_${Math.random().toString(36).slice(2)}__`;
    const globalState = globalThis as Record<string, unknown>;
    let releaseImport!: () => void;
    globalState[gateKey] = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const SLOW_SOURCE = `
      export default async (host) => {
        await globalThis[${JSON.stringify(gateKey)}];
        host.bind(host.kb.embedding, {
          read: () => ({
            name: 'slow',
            model: 'slow',
            dims: 1,
            normalization: 'l2',
            specId: 'slow:1:l2',
            embedDocuments: async () => [],
            embedQuery: async () => new Float32Array([0]),
          }),
          consumer: { id: 'slow-embedder', authority: 'journal' },
        });
      };
    `;
    const SLOW_ENTRY = {
      id: 'slow-embedder',
      version: '0.0.0',
      specifier: javascriptDataUrl(SLOW_SOURCE),
      tier: 'installed',
      description: 'slow equip',
      fills: ['kb.embedding'],
    } as const;

    try {
      const { kb, state, lifecycle } = createLifecycleHarness({
        manifest: [SLOW_ENTRY] as unknown as readonly (typeof FAKE_EMBEDDER_ENTRY)[],
        getLifecyclePhase: () => phase,
      });

      const equipPromise = lifecycle.equip('slow-embedder');
      // Yield until the engine body is awaiting the gate. A few microtask
      // rounds is enough for dynamic-import + the first await inside default().
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
      phase = 'draining';
      releaseImport();

      await expect(equipPromise).rejects.toMatchObject({ code: 'expansion_equip_aborted' });
      expect(kb.embedding.heldBy).toBeUndefined();
      expect(state.snapshot()).toEqual([]);
      expect(lifecycle.has('slow-embedder')).toBe(false);
    } finally {
      delete globalState[gateKey];
    }
  });

  // G8: equip(X) and unequip(X) running concurrently must serialize so the
  // post-condition (row presence iff scope alive) holds — never half-installed.
  it('serializes overlapping equip/unequip calls for the same engine', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness();

    const equipFirst = lifecycle.equip('test-embedder');
    // Without awaiting, fire unequip — the per-engine mutex must hold it
    // until the equip lifecycle bookkeeping completes.
    const unequipPromise = lifecycle
      .unequip('test-embedder')
      .catch((error: unknown) => ({ failed: error as Error }));

    await equipFirst;
    const unequipResult = await unequipPromise;

    expect(unequipResult).not.toMatchObject({ failed: expect.anything() });
    expect(kb.embedding.heldBy).toBeUndefined();
    expect(state.snapshot()).toEqual([]);
    expect(lifecycleScopes(lifecycle).get('test-embedder')).toBeUndefined();

    // Run the inverse direction too: the post-condition must hold under
    // both orderings.
    await lifecycle.equip('test-embedder');
    expect(kb.embedding.heldBy).toBe('test-embedder');
    expect(state.snapshot()).toHaveLength(1);
  });
});
