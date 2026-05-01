import { describe, expect, it, vi, afterEach } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/coordinator/expansion/state.js';
import { expansionStatusSchema, expansionViewSchema } from '#src/expansion/rpc-contract.js';
import { createScope, decorateDispose } from '#src/expansion/scope.js';
import { BUNDLED_ENGINES, BUNDLED_LOADERS } from '#src/expansion/bundled.js';
import type { EngineManifest, Expansion } from '#src/expansion/contract.js';
import { disposeExpansionScope } from '#src/expansion/host.js';
import type { EngineArtifactRegistration } from '#src/kb/corpus/artifact-registry.js';
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
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        apply: async () => {},
      },
    });
  };
`;

// Bundled-tier engines run through static dispatch — tests inject their stubs
// via `bundledLoaders` keyed by id, never by data URL specifier. The real
// `BUNDLED_LOADERS` is spread in so tests that exercise the canonical orama
// entry (`ORAMA_ENTRY` below) still resolve.
const SYNTHETIC_BUNDLED_LOADERS: Readonly<Record<string, Expansion>> = {
  ...BUNDLED_LOADERS,
  'orama-fts-only': (host) => {
    host.bind(host.kb.fts, {
      read: () => ({
        search: async () => ({ hits: [], exhausted: true }),
        tokenize: () => [],
        warnings: () => [],
      }),
      consumer: {
        id: 'orama-fts-only-base',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'base',
        corpusInterest: 'content',
        apply: async () => {},
      },
    } as never);
  },
  'bundled-vector': (host) => {
    host.bind(host.kb.vector, {
      read: () => ({
        search: async () => ({ hits: [] }),
      }),
      consumer: {
        id: 'bundled-vector-base',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'base',
        corpusInterest: 'content',
        apply: async () => {},
      },
    } as never);
  },
};

// Specifier kept on bundled-tier manifest entries for schema parity but unused
// at runtime — see SYNTHETIC_BUNDLED_LOADERS above.
const UNUSED_BUNDLED_SPECIFIER = '#unused-test-specifier';

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
  specifier: UNUSED_BUNDLED_SPECIFIER,
  tier: 'bundled',
  description: 'synthetic bundled FTS backend',
  fills: ['kb.fts'],
} as const;

const BUNDLED_VECTOR_SYNTHETIC_ENTRY = {
  id: 'bundled-vector',
  version: '0.0.0',
  specifier: UNUSED_BUNDLED_SPECIFIER,
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
    bundledLoaders: SYNTHETIC_BUNDLED_LOADERS,
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

describe('disposeExpansionScope ordering', () => {
  it('runs artifact-port unregister BEFORE consumer-handle stop/unregister', async () => {
    const trace: string[] = [];

    const { kb, makeHost } = createTestRuntime({
      registerConsumer: (reg) => ({
        id: reg.id,
        registrationKind: 'expansion',
        lastApplyError: null,
        stop: async () => {
          trace.push(`consumer-stop:${reg.id}`);
        },
        unregister: async () => {
          trace.push(`consumer-unregister:${reg.id}`);
        },
        status: () => ({
          authority: 'corpus',
          corpusInterest: 'content',
          snapshotId: null,
          contentSeq: 0,
          metadataSeq: 0,
          contentManifestHash: null,
          metadataManifestHash: null,
          pending: false,
          lastApplyError: null,
        }),
      }),
    });

    const trackedRegistration: EngineArtifactRegistration = {
      unregister: () => {
        trace.push('artifact-unregister');
      },
    };
    vi.spyOn(kb.engineArtifactRegistry, 'register').mockImplementation(() => trackedRegistration);

    const scope = createScope();
    decorateDispose(scope, () => {
      trace.push('scope-decorated-dispose');
    });

    const host = makeHost('order-test-engine', scope, 'installed');
    const consumerHandle = host.registerConsumer(
      {
        id: 'order-test-consumer',
        authority: 'corpus',
        kind: 'apply',
        corpusInterest: 'content',
        apply: async () => {},
      },
      scope,
    );
    host.registerArtifactPort(
      { describeArtifacts: async () => [] },
      { targetConsumerHandles: [consumerHandle] },
      scope,
    );

    await disposeExpansionScope(scope);

    // Ordering claim (AC2.4 lifecycle): artifact-port unregister runs BEFORE
    // any consumer-handle stop/unregister. The trace may contain repeated
    // entries because `scope[Symbol.dispose]()` re-runs decorated callbacks
    // (LIFO via `decorateDispose`) — that is implementation detail of the
    // host's registration helpers, not of `disposeExpansionScope` itself.
    // The boundary contract is the FIRST occurrence of each marker.
    const firstArtifact = trace.indexOf('artifact-unregister');
    const firstConsumerStop = trace.indexOf('consumer-stop:order-test-consumer');
    const firstConsumerUnregister = trace.indexOf('consumer-unregister:order-test-consumer');
    const firstScopeDecorated = trace.indexOf('scope-decorated-dispose');

    expect(firstArtifact).toBeGreaterThanOrEqual(0);
    expect(firstConsumerStop).toBeGreaterThanOrEqual(0);
    expect(firstConsumerUnregister).toBeGreaterThanOrEqual(0);
    expect(firstScopeDecorated).toBeGreaterThanOrEqual(0);

    expect(firstArtifact).toBeLessThan(firstConsumerStop);
    expect(firstConsumerStop).toBeLessThan(firstConsumerUnregister);
    expect(firstConsumerUnregister).toBeLessThan(firstScopeDecorated);
  });

  it('handles a scope with no artifact ports and no consumer handles', async () => {
    const scope = createScope();
    const trace: string[] = [];
    decorateDispose(scope, () => {
      trace.push('decorated');
    });

    await disposeExpansionScope(scope);
    expect(trace).toEqual(['decorated']);
  });
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

  // #18: equip(X) called once the coordinator is already draining must be
  // rejected at the synchronous phase fence, BEFORE any dynamic import — so
  // there is no observation window where the binding is mutated but the scope
  // has not yet been registered.
  it('rejects equip immediately when the coordinator is already draining', async () => {
    const phase: 'starting' | 'running' | 'draining' | 'stopped' = 'draining';
    const TRACED_SOURCE = `
      globalThis.__cluster_T_import_attempted__ = true;
      export default (host) => {
        host.bind(host.kb.embedding, {
          read: () => ({
            name: 'traced',
            model: 'traced',
            dims: 1,
            normalization: 'l2',
            specId: 'traced:1:l2',
            embedDocuments: async () => [],
            embedQuery: async () => new Float32Array([0]),
          }),
          consumer: { id: 'traced-embedder', kind: 'stateless', registrationKind: 'stateless' },
        });
      };
    `;
    const TRACED_ENTRY = {
      id: 'traced-embedder',
      version: '0.0.0',
      specifier: javascriptDataUrl(TRACED_SOURCE),
      tier: 'installed',
      description: 'traced equip',
      fills: ['kb.embedding'],
    } as const;
    const globalState = globalThis as Record<string, unknown>;

    try {
      delete globalState.__cluster_T_import_attempted__;
      const { kb, state, lifecycle } = createLifecycleHarness({
        manifest: [TRACED_ENTRY] as unknown as readonly (typeof FAKE_EMBEDDER_ENTRY)[],
        getLifecyclePhase: () => phase,
      });

      await expect(lifecycle.equip('traced-embedder')).rejects.toMatchObject({
        code: 'expansion_equip_aborted',
      });

      expect(globalState.__cluster_T_import_attempted__).toBeUndefined();
      expect(kb.embedding.heldBy).toBeUndefined();
      expect(state.snapshot()).toEqual([]);
      expect(lifecycle.has('traced-embedder')).toBe(false);
    } finally {
      delete globalState.__cluster_T_import_attempted__;
    }
  });

  // #18 + #13a: shutdown that fires WHILE an equip is mid-import must wait for
  // the in-flight equip to publish its scope (via engineMutex), then dispose
  // it cooperatively. The post-condition is `scopes.has(id) iff state.get(id)`
  // — both empty after shutdown, no orphan binding left behind.
  it('disposes a mid-import equip cooperatively when shutdown overlaps', async () => {
    let phase: 'starting' | 'running' | 'draining' | 'stopped' = 'running';
    const gateKey = `__cluster_T_shutdown_gate_${Math.random().toString(36).slice(2)}__`;
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
          consumer: { id: 'slow-embedder', kind: 'stateless', registrationKind: 'stateless' },
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
      // Yield until the engine body is awaiting the gate.
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
      phase = 'draining';
      const shutdownPromise = lifecycle.shutdownActiveExpansions();
      // Shutdown must not race ahead of the in-flight equip's publish step.
      releaseImport();

      await equipPromise;
      await shutdownPromise;

      expect(kb.embedding.heldBy).toBeUndefined();
      // Equip past the fence completed normally (state row written), shutdown
      // then disposed the scope cooperatively.
      expect(state.snapshot()).toEqual([{ id: 'slow-embedder', version: '0.0.0', installed_at: FIXED_NOW }]);
      expect(lifecycleScopes(lifecycle).get('slow-embedder')).toBeUndefined();
      expect(lifecycle.isActive('slow-embedder')).toBe(false);
    } finally {
      delete globalState[gateKey];
    }
  });

  // #13b: a user equip(X) racing with applyBundledFallback that targets the
  // same binding must serialize through the per-engine mutex. Exactly one
  // body publishes a scope, the loser cleans up, and the post-condition
  // `scopes.has(id) iff state.get(id)` is preserved on both engines.
  it('serializes user equip and bundled fallback that target the same binding', async () => {
    const USER_VECTOR_ENTRY = {
      id: 'needle',
      version: '0.0.0',
      specifier: javascriptDataUrl(SYNTHETIC_VECTOR_SOURCE),
      tier: 'installed',
      description: 'user vector engine',
      onboarding: [{ kind: 'require-binding', binding: 'kb.embedding' }],
      fills: ['kb.vector'],
    } as const;

    const { kb, state, lifecycle } = createLifecycleHarness({
      manifest: [GEMINI_SYNTHETIC_ENTRY, USER_VECTOR_ENTRY, BUNDLED_VECTOR_SYNTHETIC_ENTRY],
    });

    // `needle` requires `kb.embedding` to be filled before binding `kb.vector`,
    // so equip a synthetic embedder first. The race we exercise is on
    // `kb.vector` — both `needle` (user) and `bundled-vector` (fallback)
    // declare `fills: ['kb.vector']`.
    await lifecycle.equip('gemini');

    // Fire user equip and bundled fallback concurrently. The two run on
    // different engineMutex keys (`needle` vs `bundled-vector`), but they
    // both bind `kb.vector` — so the binding's structural single-occupancy
    // determines the winner. Whichever resolves first publishes the scope;
    // the other's body throws `binding_occupied` and the lifecycle disposes
    // the loser's scope without leaking state.
    const userEquipPromise = lifecycle
      .equip('needle')
      .then(() => ({ kind: 'ok' as const }))
      .catch((error: unknown) => ({ kind: 'err' as const, error: error as Error }));
    const fallbackPromise = lifecycle.applyBundledFallback();

    const [userResult, fallbackResult] = await Promise.all([userEquipPromise, fallbackPromise]);

    // Exactly one party fills `kb.vector`; the other's body throws and is
    // recorded (user → rejected promise; fallback → entry in `failed` map).
    const userWon = userResult.kind === 'ok';
    const fallbackWon = fallbackResult.equipped.includes('bundled-vector');
    expect(userWon !== fallbackWon).toBe(true);

    if (userWon) {
      expect(kb.vector.heldBy).toBe('needle');
      expect(lifecycleScopes(lifecycle).get('needle')).toHaveLength(1);
      expect(lifecycleScopes(lifecycle).get('bundled-vector')).toBeUndefined();
      expect(state.snapshot().some((row) => row.id === 'needle')).toBe(true);
    } else {
      expect(kb.vector.heldBy).toBe('bundled-vector');
      expect(lifecycleScopes(lifecycle).get('bundled-vector')).toHaveLength(1);
      expect(lifecycleScopes(lifecycle).get('needle')).toBeUndefined();
      expect(state.snapshot().some((row) => row.id === 'needle')).toBe(false);
      expect(userResult.kind === 'err' && userResult.error.message).toBeTruthy();
    }

    // Post-condition: `scopes.has(id) iff state.get(id)` on every installed
    // engine the test touched.
    for (const id of ['gemini', 'needle']) {
      const hasScope = (lifecycleScopes(lifecycle).get(id) ?? []).length > 0;
      const hasRow = state.snapshot().some((row) => row.id === id);
      expect(hasScope).toBe(hasRow);
    }
  });

  // G8: equip(X) and unequip(X) running concurrently must serialize so the
  // post-condition (row presence iff scope alive) holds — never half-installed.
  it('serializes overlapping equip/unequip calls for the same engine', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness();

    const equipFirst = lifecycle.equip('test-embedder');
    // Without awaiting, fire unequip — the per-engine mutex must hold it
    // until the equip lifecycle bookkeeping completes.
    const unequipPromise = lifecycle.unequip('test-embedder').catch((error: unknown) => ({ failed: error as Error }));

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
