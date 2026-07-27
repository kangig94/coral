import { describe, expect, it, vi, afterEach } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { ExpansionLifecycleService } from '#src/kb-daemon/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/kb-daemon/expansion/state.js';
import { expansionStatusSchema, expansionViewSchema } from '#src/expansion/rpc-contract.js';
import { createScope, decorateDispose } from '#src/expansion/scope.js';
import { BUNDLED_ENGINES, BUNDLED_LOADERS } from '#src/expansion/bundled.js';
import type { EngineManifest, Expansion } from '#src/expansion/contract.js';
import { disposeExpansionScope } from '#src/expansion/host.js';
import type { EngineArtifactRegistration } from '#src/kb/corpus/artifact-registry.js';
import { KB_EMBEDDING_CAPABILITY, KB_FTS_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import type { Disposable } from '#src/runtime/ports.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const FIXED_NOW = '2026-04-27T00:00:00.000Z';

function javascriptDataUrl(source: string): string {
  return `data:application/javascript,${encodeURIComponent(source)}`;
}

const SYNTHETIC_EMBEDDER_SOURCE = `
  export default (host) => {
    host.bind('kb.embedding', {
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
    host.require('kb.embedding');
    host.bind('kb.vector', {
      read: () => ({
        search: async () => ({ hits: [] }),
      }),
      consumer: {
        id: 'vector',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        apply: async () => {},
      },
    });
  };
`;

const PARTIAL_ROLE_ONE = {
  id: 'partial-one',
  label: 'Partial One',
  tags: ['lexical'],
  phase: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  provides: 'retrieval-source',
} as const satisfies RetrievalRoleDescriptor;

const PARTIAL_ROLE_TWO = {
  id: 'partial-two',
  label: 'Partial Two',
  tags: ['lexical'],
  phase: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  provides: 'retrieval-source',
} as const satisfies RetrievalRoleDescriptor;

function partialRoleExpansionSource(): string {
  return `
    export default (host) => {
      const descriptor = ${JSON.stringify(PARTIAL_ROLE_ONE)};
      host.registerRetrievalRole({
        id: descriptor.id,
        descriptor,
        search: async () => ({ hits: [] }),
      }, host.scope);
    };
  `;
}

// Bundled-tier engines run through static dispatch — tests inject their stubs
// via `bundledLoaders` keyed by id, never by data URL specifier. The real
// `BUNDLED_LOADERS` is spread in so tests that exercise the canonical orama
// entry (`ORAMA_ENTRY` below) still resolve.
const SYNTHETIC_BUNDLED_LOADERS: Readonly<Record<string, Expansion>> = {
  ...BUNDLED_LOADERS,
  'orama-fts-only': (host) => {
    host.bind(KB_FTS_CAPABILITY, {
      read: () => ({
        search: async () => ({ hits: [], exhausted: true }),
        tokenize: async () => [],
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
    host.bind(KB_VECTOR_CAPABILITY, {
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
  'partial-bundled': (host) => {
    host.registerRetrievalRole(
      {
        id: PARTIAL_ROLE_ONE.id,
        descriptor: PARTIAL_ROLE_ONE,
        async search() {
          return { hits: [] };
        },
      },
      host.scope,
    );
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
  fills: [KB_EMBEDDING_CAPABILITY],
} as const;

const VECTOR_ENTRY = {
  id: 'vector',
  version: '0.2.0',
  specifier: javascriptDataUrl(SYNTHETIC_VECTOR_SOURCE),
  tier: 'installed',
  description: 'fixture vector backend',
  onboarding: [{ kind: 'require-binding', binding: KB_EMBEDDING_CAPABILITY }],
  fills: [KB_VECTOR_CAPABILITY],
} as const;

const GEMINI_SYNTHETIC_ENTRY = {
  id: 'gemini',
  version: '0.0.0',
  specifier: javascriptDataUrl(SYNTHETIC_EMBEDDER_SOURCE),
  tier: 'installed',
  description: 'synthetic installed embedder',
  fills: [KB_EMBEDDING_CAPABILITY],
} as const;

const VECTOR_SYNTHETIC_ENTRY = {
  id: 'vector',
  version: '0.0.0',
  specifier: javascriptDataUrl(SYNTHETIC_VECTOR_SOURCE),
  tier: 'installed',
  description: 'synthetic installed vector backend',
  onboarding: [{ kind: 'require-binding', binding: KB_EMBEDDING_CAPABILITY }],
  fills: [KB_VECTOR_CAPABILITY],
} as const;

const BUNDLED_FTS_SYNTHETIC_ENTRY = {
  id: 'orama-fts-only',
  version: '0.0.0',
  specifier: UNUSED_BUNDLED_SPECIFIER,
  tier: 'bundled',
  description: 'synthetic bundled FTS backend',
  fills: [KB_FTS_CAPABILITY],
} as const;

const BUNDLED_VECTOR_SYNTHETIC_ENTRY = {
  id: 'bundled-vector',
  version: '0.0.0',
  specifier: UNUSED_BUNDLED_SPECIFIER,
  tier: 'bundled',
  description: 'synthetic bundled vector backend',
  fills: [KB_VECTOR_CAPABILITY],
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
    protectedPackageIds?: ReadonlySet<string>;
    retireCatalogAbsent?: (name: string, finalizeState: () => void) => Promise<'current' | 'removed'>;
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
    ...(options.protectedPackageIds === undefined ? {} : { protectedPackageIds: options.protectedPackageIds }),
    ...(options.retireCatalogAbsent === undefined ? {} : { retireCatalogAbsent: options.retireCatalogAbsent }),
  });
  return { kb, state, lifecycle };
}

function lifecycleScopes(lifecycle: ExpansionLifecycleService): Map<string, Disposable[]> {
  return (lifecycle as unknown as { scopes: Map<string, Disposable[]> }).scopes;
}

function heldBy(
  kb: KbRuntime,
  name: typeof KB_EMBEDDING_CAPABILITY | typeof KB_VECTOR_CAPABILITY | typeof KB_FTS_CAPABILITY,
): string | undefined {
  return kb.capabilityRegistry.runtimeView().status(name)?.heldBy;
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

    const host = makeHost(
      {
        id: 'order-test-engine',
        version: '0.0.0',
        specifier: '#tests/order-test-engine/expansion.js',
        tier: 'installed',
        description: 'order test engine',
      },
      scope,
    );
    const consumerHandle = host.registerConsumer(
      {
        id: 'order-test-engine',
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
    const firstConsumerStop = trace.indexOf('consumer-stop:order-test-engine');
    const firstConsumerUnregister = trace.indexOf('consumer-unregister:order-test-engine');
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
  it('routes only catalog-absent, unprotected ids into retirement and finalizes state there', async () => {
    const retireCatalogAbsent = vi.fn(async (_name: string, finalizeState: () => void): Promise<'removed'> => {
      finalizeState();
      return 'removed';
    });
    const { lifecycle, state } = createLifecycleHarness({
      manifest: BUNDLED_ENGINES,
      rows: [
        {
          id: 'retired-vector',
          version: '0.9.0',
          installed_at: FIXED_NOW,
        },
      ],
      protectedPackageIds: new Set(['kiwi', 'codebase-memory']),
      retireCatalogAbsent,
    });

    await expect(lifecycle.removeExpansionCatalog('retired-vector')).resolves.toEqual({
      status: 'removed',
    });
    expect(retireCatalogAbsent).toHaveBeenCalledOnce();
    expect(state.get('retired-vector')).toBeUndefined();

    for (const id of ['gemini', 'onnx', 'orama']) {
      await expect(lifecycle.removeExpansionCatalog(id)).resolves.toEqual({
        status: 'immutable',
      });
    }
    for (const id of ['kiwi', 'codebase-memory']) {
      await expect(lifecycle.removeExpansionCatalog(id)).resolves.toEqual({
        status: 'unknown',
      });
    }
    expect(retireCatalogAbsent).toHaveBeenCalledOnce();
  });

  it('does not finalize state when a fresh catalog read reports current', async () => {
    const retireCatalogAbsent = vi.fn(async (): Promise<'current'> => 'current');
    const { lifecycle, state } = createLifecycleHarness({
      manifest: [],
      rows: [
        {
          id: 'registered-during-cleanup',
          version: '1.0.0',
          installed_at: FIXED_NOW,
        },
      ],
      retireCatalogAbsent,
    });

    await expect(lifecycle.removeExpansionCatalog('registered-during-cleanup')).resolves.toEqual({ status: 'unknown' });
    expect(state.get('registered-during-cleanup')).toBeDefined();
  });

  it('equips and unequips an installed expansion through expansion_state', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness();

    await lifecycle.equip('test-embedder');

    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('test-embedder');
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

    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBeUndefined();
    expect(state.snapshot()).toEqual([]);
    expect(lifecycle.info('test-embedder')).toMatchObject({
      id: 'test-embedder',
      version: '0.0.0',
      status: 'inactive',
    });
  });

  it('revalidates an injected installed manifest id at equip ingress', async () => {
    const unsafe = { ...FAKE_EMBEDDER_ENTRY, id: '../escape' } as EngineManifest;
    const { lifecycle, state } = createLifecycleHarness({ manifest: [unsafe] });

    await expect(lifecycle.equip('../escape')).rejects.toThrow(/is unsafe/u);
    expect(state.snapshot()).toEqual([]);
  });

  it('rolls back bound state when writing the expansion row fails', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness();
    vi.mocked(state.insert).mockImplementation(() => {
      throw new Error('row write failed');
    });

    await expect(lifecycle.equip('test-embedder')).rejects.toThrow('row write failed');

    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBeUndefined();
    expect(state.snapshot()).toEqual([]);
    expect(lifecycle.has('test-embedder')).toBe(false);
  });

  it('preserves retired expansion rows during boot recovery and exposes cleanup remediation', async () => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const { state, lifecycle } = createLifecycleHarness({
      rows: [{ id: 'ghost', version: '1.0.0', installed_at: FIXED_NOW }],
    });

    await lifecycle.recoverOnBoot();

    expect(state.snapshot()).toEqual([{ id: 'ghost', version: '1.0.0', installed_at: FIXED_NOW }]);
    expect(lifecycle.info('ghost')).toMatchObject({
      id: 'ghost',
      status: 'installed-not-active',
      lastError: "Run 'coral-cli expansion remove-catalog ghost' to remove retired expansion artifacts.",
    });
    expect(warn).toHaveBeenCalledWith(
      "Retired expansion row 'ghost' preserved. Run 'coral-cli expansion remove-catalog ghost' to remove retired expansion artifacts.",
    );
  });

  it('does not emit an executable cleanup command for an unsafe retired row id', async () => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const unsafeId = 'bad; touch /tmp/injected';
    const { state, lifecycle } = createLifecycleHarness({
      rows: [{ id: unsafeId, version: '1.0.0', installed_at: FIXED_NOW }],
    });

    await lifecycle.recoverOnBoot();

    expect(state.snapshot()).toEqual([{ id: unsafeId, version: '1.0.0', installed_at: FIXED_NOW }]);
    expect(lifecycle.info(unsafeId)).toMatchObject({
      id: unsafeId,
      status: 'installed-not-active',
      lastError: expect.stringContaining('cannot provide an executable cleanup command'),
    });
    expect(lifecycle.info(unsafeId)?.lastError).not.toContain(unsafeId);
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining(unsafeId));
  });

  it('preserves failed recovery rows and reports installed-not-active with lastError', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness({
      manifest: [VECTOR_ENTRY] as unknown as readonly (typeof FAKE_EMBEDDER_ENTRY)[],
      rows: [{ id: 'vector', version: '0.2.0', installed_at: FIXED_NOW }],
    });

    await lifecycle.recoverOnBoot();

    expect(state.snapshot()).toEqual([{ id: 'vector', version: '0.2.0', installed_at: FIXED_NOW }]);
    expect(heldBy(kb, KB_VECTOR_CAPABILITY)).toBeUndefined();
    expect(lifecycle.info('vector')).toMatchObject({
      id: 'vector',
      version: '0.2.0',
      status: 'installed-not-active',
      lastError: expect.stringContaining("Binding 'kb.embedding'"),
    });
  });

  it('does not auto-load bundled expansions on an empty expansion_state table', async () => {
    const { kb, lifecycle } = createLifecycleHarness();

    await lifecycle.recoverOnBoot();

    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBeUndefined();
    expect(lifecycle.list()).toMatchObject([
      {
        id: 'test-embedder',
        version: '0.0.0',
        tier: 'installed',
        status: 'inactive',
      },
    ]);
  });

  it('skips bundled fallback when declared fills are already held', async () => {
    const { kb, lifecycle } = createLifecycleHarness({
      manifest: [FAKE_EMBEDDER_ENTRY, ORAMA_ENTRY],
    });

    const first = await lifecycle.applyBundledFallback();

    expect(first.equipped).toEqual(['orama']);
    expect(first.failed.size).toBe(0);
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);

    const second = await lifecycle.applyBundledFallback();

    expect(second.equipped).toEqual([]);
    expect(second.failed.size).toBe(0);
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);

    await lifecycle.equip('test-embedder');
    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('test-embedder');

    await lifecycle.unequip('test-embedder');
    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBeUndefined();
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);

    const afterUnrelatedUnequip = await lifecycle.applyBundledFallback();

    expect(afterUnrelatedUnequip.equipped).toEqual([]);
    expect(afterUnrelatedUnequip.failed.size).toBe(0);
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('orama');
    expect(lifecycleScopes(lifecycle).get('orama')).toHaveLength(1);
  });

  it('rejects unequipping a binding provider required by an active engine', async () => {
    const expected = documentedCoralSetupError({
      code: 'capability_required_by_active_engine',
      target: 'gemini',
      capabilities: [
        {
          capability: KB_EMBEDDING_CAPABILITY,
          dependents: [
            {
              expansion: 'vector',
              edgeKind: 'read',
              source: 'onboarding',
              state: 'active',
            },
          ],
        },
      ],
    });
    const { kb, lifecycle } = createLifecycleHarness({
      manifest: [GEMINI_SYNTHETIC_ENTRY, VECTOR_SYNTHETIC_ENTRY],
    });

    await lifecycle.equip('gemini');
    await lifecycle.equip('vector');

    await expect(lifecycle.unequip('gemini')).rejects.toMatchObject({
      code: expected.code,
      message: expected.message,
      context: expected.context,
    });
    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('gemini');
    expect(heldBy(kb, KB_VECTOR_CAPABILITY)).toBe('vector');
  });

  it('re-runs bundled fallback after unequipping an installed engine and refills an empty slot', async () => {
    const { kb, state, lifecycle } = createLifecycleHarness({
      manifest: [
        GEMINI_SYNTHETIC_ENTRY,
        VECTOR_SYNTHETIC_ENTRY,
        BUNDLED_FTS_SYNTHETIC_ENTRY,
        BUNDLED_VECTOR_SYNTHETIC_ENTRY,
      ],
      rows: [
        { id: 'gemini', version: '0.0.0', installed_at: FIXED_NOW },
        { id: 'vector', version: '0.0.0', installed_at: FIXED_NOW },
      ],
    });

    await lifecycle.recoverOnBoot();

    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('gemini');
    expect(heldBy(kb, KB_VECTOR_CAPABILITY)).toBe('vector');
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('orama-fts-only');
    expect(lifecycleScopes(lifecycle).get('bundled-vector')).toBeUndefined();

    await lifecycle.unequip('vector');

    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('gemini');
    expect(heldBy(kb, KB_VECTOR_CAPABILITY)).toBe('bundled-vector');
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('orama-fts-only');
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
        host.bind('kb.embedding', provider);
      };
    `;
    const specifier = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
    const SPY_ENTRY = {
      id: 'spy-embedder',
      version: '0.0.0',
      specifier,
      tier: 'installed',
      description: 'dispose spy',
      fills: [KB_EMBEDDING_CAPABILITY],
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
      fills: [KB_EMBEDDING_CAPABILITY],
    } as const;
    const { kb, lifecycle } = createLifecycleHarness({
      manifest: [FAKE_EMBEDDER_ENTRY, SECOND_EMBEDDER],
    });

    await lifecycle.equip('test-embedder');
    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('test-embedder');

    await expect(lifecycle.equip('second-embedder')).rejects.toMatchObject({
      code: 'binding_occupied',
      context: { binding: 'kb.embedding', heldBy: 'test-embedder' },
    });
    // First embedder remains bound; the failed second equip rolled back its scope.
    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('test-embedder');
  });

  it('accepts installed-not-active in expansion schemas and allows lastError on the view', () => {
    expect(expansionStatusSchema.parse('installed-not-active')).toBe('installed-not-active');
    expect(
      expansionViewSchema.parse({
        name: 'vector',
        tier: 'installed',
        status: 'installed-not-active',
        lastError: 'binding missing',
      }),
    ).toEqual({
      name: 'vector',
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
        host.bind('kb.embedding', {
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
      fills: [KB_EMBEDDING_CAPABILITY],
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
      expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBeUndefined();
      expect(state.snapshot()).toEqual([]);
      expect(lifecycle.has('traced-embedder')).toBe(false);
    } finally {
      delete globalState.__cluster_T_import_attempted__;
    }
  });

  it('rejects equip that resumes from the serialized queue after draining begins', async () => {
    let phase: 'starting' | 'running' | 'draining' | 'stopped' = 'running';
    const gateKey = `__cluster_T_queued_dispose_gate_${Math.random().toString(36).slice(2)}__`;
    const globalState = globalThis as Record<string, unknown>;
    let releaseImport!: () => void;
    globalState[gateKey] = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const QUEUED_SOURCE = `
      export default async (host) => {
        await globalThis[${JSON.stringify(gateKey)}];
        host.bind('kb.embedding', {
          read: () => ({
            name: 'queued',
            model: 'queued',
            dims: 1,
            normalization: 'l2',
            specId: 'queued:1:l2',
            embedDocuments: async () => [],
            embedQuery: async () => new Float32Array([0]),
          }),
          consumer: { id: 'queued-embedder', kind: 'stateless', registrationKind: 'stateless' },
        });
      };
    `;
    const QUEUED_ENTRY = {
      id: 'queued-embedder',
      version: '0.0.0',
      specifier: javascriptDataUrl(QUEUED_SOURCE),
      tier: 'installed',
      description: 'queued dispose fence',
      fills: [KB_EMBEDDING_CAPABILITY],
    } as const;

    try {
      const { kb, state, lifecycle } = createLifecycleHarness({
        manifest: [QUEUED_ENTRY] as unknown as readonly (typeof FAKE_EMBEDDER_ENTRY)[],
        getLifecyclePhase: () => phase,
      });

      const firstEquip = lifecycle.equip('queued-embedder');
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
      const queuedEquip = lifecycle.equip('queued-embedder');

      phase = 'draining';
      releaseImport();

      await firstEquip;
      await expect(queuedEquip).rejects.toMatchObject({
        code: 'expansion_equip_aborted',
      });

      expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('queued-embedder');
      expect(state.snapshot()).toEqual([{ id: 'queued-embedder', version: '0.0.0', installed_at: FIXED_NOW }]);
      expect(lifecycleScopes(lifecycle).get('queued-embedder')).toHaveLength(1);
    } finally {
      delete globalState[gateKey];
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
        host.bind('kb.embedding', {
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
      fills: [KB_EMBEDDING_CAPABILITY],
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

      expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBeUndefined();
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
      id: 'vector',
      version: '0.0.0',
      specifier: javascriptDataUrl(SYNTHETIC_VECTOR_SOURCE),
      tier: 'installed',
      description: 'user vector engine',
      onboarding: [{ kind: 'require-binding', binding: KB_EMBEDDING_CAPABILITY }],
      fills: [KB_VECTOR_CAPABILITY],
    } as const;

    const { kb, state, lifecycle } = createLifecycleHarness({
      manifest: [GEMINI_SYNTHETIC_ENTRY, USER_VECTOR_ENTRY, BUNDLED_VECTOR_SYNTHETIC_ENTRY],
    });

    // `vector` requires `kb.embedding` to be filled before binding `kb.vector`,
    // so equip a synthetic embedder first. The race we exercise is on
    // `kb.vector` — both `vector` (user) and `bundled-vector` (fallback)
    // declare `fills: ['kb.vector']`.
    await lifecycle.equip('gemini');

    // Fire user equip and bundled fallback concurrently. The two run on
    // different engineMutex keys (`vector` vs `bundled-vector`), but they
    // both bind `kb.vector` — so the binding's structural single-occupancy
    // determines the winner. Whichever resolves first publishes the scope;
    // the other's body throws `binding_occupied` and the lifecycle disposes
    // the loser's scope without leaking state.
    const userEquipPromise = lifecycle
      .equip('vector')
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
      expect(heldBy(kb, KB_VECTOR_CAPABILITY)).toBe('vector');
      expect(lifecycleScopes(lifecycle).get('vector')).toHaveLength(1);
      expect(lifecycleScopes(lifecycle).get('bundled-vector')).toBeUndefined();
      expect(state.snapshot().some((row) => row.id === 'vector')).toBe(true);
    } else {
      expect(heldBy(kb, KB_VECTOR_CAPABILITY)).toBe('bundled-vector');
      expect(lifecycleScopes(lifecycle).get('bundled-vector')).toHaveLength(1);
      expect(lifecycleScopes(lifecycle).get('vector')).toBeUndefined();
      expect(state.snapshot().some((row) => row.id === 'vector')).toBe(false);
      expect(userResult.kind === 'err' && userResult.error.message).toBeTruthy();
    }

    // Post-condition: `scopes.has(id) iff state.get(id)` on every installed
    // engine the test touched.
    for (const id of ['gemini', 'vector']) {
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
    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBeUndefined();
    expect(state.snapshot()).toEqual([]);
    expect(lifecycleScopes(lifecycle).get('test-embedder')).toBeUndefined();

    // Run the inverse direction too: the post-condition must hold under
    // both orderings.
    await lifecycle.equip('test-embedder');
    expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('test-embedder');
    expect(state.snapshot()).toHaveLength(1);
  });

  it('rethrows role_descriptor_unregistered from installed equip and disposes the partial role scope', async () => {
    const PARTIAL_INSTALLED_ENTRY = {
      id: 'partial-installed',
      version: '0.0.0',
      specifier: javascriptDataUrl(partialRoleExpansionSource()),
      tier: 'installed',
      description: 'partial installed role expansion',
      provides: { retrievalRoles: [PARTIAL_ROLE_ONE, PARTIAL_ROLE_TWO] },
    } as const;
    const { kb, state, lifecycle } = createLifecycleHarness({
      manifest: [PARTIAL_INSTALLED_ENTRY] as unknown as readonly EngineManifest[],
    });

    await expect(lifecycle.equip('partial-installed')).rejects.toMatchObject({
      code: 'role_descriptor_unregistered',
      context: {
        expansion: 'partial-installed',
        missing: 'partial-two',
      },
    });

    expect(state.snapshot()).toEqual([]);
    expect(lifecycleScopes(lifecycle).get('partial-installed')).toBeUndefined();
    expect(kb.roleRegistry.list().some((record) => record.descriptor.id === 'partial-one')).toBe(false);
  });

  it('records role_descriptor_unregistered during bundled fallback and continues to later bundled engines', async () => {
    const PARTIAL_BUNDLED_ENTRY = {
      id: 'partial-bundled',
      version: '0.0.0',
      specifier: UNUSED_BUNDLED_SPECIFIER,
      tier: 'bundled',
      description: 'partial bundled role expansion',
      provides: { retrievalRoles: [PARTIAL_ROLE_ONE, PARTIAL_ROLE_TWO] },
    } as const;
    const { kb, lifecycle } = createLifecycleHarness({
      manifest: [PARTIAL_BUNDLED_ENTRY, BUNDLED_FTS_SYNTHETIC_ENTRY] as unknown as readonly EngineManifest[],
    });

    const fallback = await lifecycle.applyBundledFallback();

    expect(fallback.equipped).toEqual(['orama-fts-only']);
    expect(fallback.failed.get('partial-bundled')).toMatchObject({
      code: 'role_descriptor_unregistered',
      context: {
        expansion: 'partial-bundled',
        missing: 'partial-two',
      },
    });
    expect(heldBy(kb, KB_FTS_CAPABILITY)).toBe('orama-fts-only');
    expect(lifecycleScopes(lifecycle).get('partial-bundled')).toBeUndefined();
    expect(lifecycleScopes(lifecycle).get('orama-fts-only')).toHaveLength(1);
    expect(kb.roleRegistry.list().some((record) => record.descriptor.id === 'partial-one')).toBe(false);
    expect(lifecycle.info('partial-bundled')).toMatchObject({
      id: 'partial-bundled',
      status: 'installed-not-active',
      lastError: expect.stringContaining("declared retrieval roles 'partial-two'"),
    });
  });
});
