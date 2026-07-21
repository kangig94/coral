import { describe, expect, it } from 'vitest';

import { managed, none } from '#src/providers/capability.js';
import type { ProviderArtifactCapability, ProviderSpec } from '#src/providers/contract.js';
import { defineProvider, ProviderRegistry, type ProviderDefinition } from '#src/providers/registry.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';

type ProviderFacetOverrides = Partial<Pick<ProviderSpec, 'preflight' | 'appServer' | 'recovery'>> & {
  readonly artifacts?: ProviderArtifactCapability;
};

function makeSpec(name: string, overrides: ProviderFacetOverrides = {}): ProviderDefinition {
  const definition = defineProvider({
    name,
    run: async function* () {
      yield {
        kind: 'terminal',
        terminal: {
          content: `${name} response`,
          durationMs: 0,
          outcome: { kind: 'completed' as const },
        },
        diagnostics: {},
      };
    },
    ...(overrides.preflight ? { preflight: overrides.preflight } : {}),
    ...(overrides.appServer ? { appServer: overrides.appServer } : {}),
    ...(overrides.recovery ? { recovery: overrides.recovery } : {}),
  })
    .binding(fixtureProviderBindingCodec(name))
    .artifacts(overrides.artifacts ?? none(`Test provider ${name} declares no provider artifacts.`))
    .build();

  return definition;
}

function providerNames(providers: ProviderSpec[]): string[] {
  return providers.map((provider) => provider.name);
}

describe('ProviderRegistry', () => {
  it('rejects an app-server provider without provider-owned recovery interpretation', () => {
    expect(() =>
      defineProvider({
        name: 'uninterpreted',
        run: async function* () {},
        appServer: {
          name: 'uninterpreted',
          subscriptionPhase: 'afterInitialize',
          buildServerSpec: () => ({
            provider: 'uninterpreted',
            command: 'uninterpreted',
            args: [],
            cwd: '/tmp',
          }),
        },
      }),
    ).toThrow("App-server provider 'uninterpreted' must define recovery interpretation.");
  });

  it('registers and resolves provider specs', () => {
    const registry = new ProviderRegistry();
    const spec = makeSpec('codex-like');

    registry.register(spec);

    expect(registry.get('codex-like')).toBe(spec);
    expect(providerNames(registry.getAll())).toEqual(['codex-like']);
  });

  it('preserves execution behavior through the registered definition', async () => {
    const registry = new ProviderRegistry();
    registry.register(makeSpec('transparent'));
    const run = registry.get('transparent')?.run;
    if (run === undefined) throw new Error('fixture provider was not registered');

    const events = [];
    for await (const event of run({} as never, {} as never)) events.push(event);

    expect(events).toEqual([
      {
        kind: 'terminal',
        terminal: { content: 'transparent response', durationMs: 0, outcome: { kind: 'completed' } },
        diagnostics: {},
      },
    ]);
  });

  it('seals execution registration and persisted binding components as one authority', () => {
    const registry = new ProviderRegistry();
    registry.register(makeSpec('fixture'));

    expect(registry.sealPersistedBindingCodecComponents().map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.fixture.binding',
    ]);
    expect(() => registry.register(makeSpec('late'))).toThrow("registry is sealed; cannot register 'late'");
    expect(registry.get('fixture')).toBeDefined();
  });

  it('surfaces optional facets as undefined when absent', () => {
    const registry = new ProviderRegistry();
    const spec = makeSpec('claude');

    registry.register(spec);

    expect(registry.get('claude')?.appServer).toBeUndefined();
    expect(registry.get('claude')?.recovery).toBeUndefined();
    expect(registry.get('claude')?.artifacts).toEqual({
      kind: 'none',
      reason: 'Test provider claude declares no provider artifacts.',
    });
  });

  it('retains registered facets on the spec', () => {
    const registry = new ProviderRegistry();
    const appServer = {
      name: 'claude',
      subscriptionPhase: 'beforeInitialize' as const,
      buildServerSpec: () => ({ provider: 'claude', command: 'claude', args: [], cwd: process.cwd() }),
      interrupt: async () => {},
    };
    const recovery = {
      probe: async () => ({ resumable: true }),
      finalizeInterrupted: () => ({ kind: 'preserve' as const }),
      finalizeFromArtifacts: async () => ({
        terminal: {
          kind: 'terminal' as const,
          terminal: {
            content: 'recovered',
            durationMs: 0,
            outcome: { kind: 'completed' as const },
          },
          diagnostics: {},
        },
      }),
    };
    const artifacts = managed({
      discardArtifacts: async () => ({ kind: 'discarded' as const }),
    });
    const spec = makeSpec('claude', { appServer, recovery, artifacts });

    registry.register(spec);

    expect(registry.get('claude')?.appServer).toStrictEqual(appServer);
    expect(registry.get('claude')?.recovery).toStrictEqual(recovery);
    expect(registry.get('claude')?.artifacts).toStrictEqual(artifacts);
    expect(registry.get('claude')?.appServer).toBe(appServer);
    expect(registry.get('claude')?.recovery).toBe(recovery);
    expect(registry.get('claude')?.artifacts).toBe(artifacts);
    expect(Object.isFrozen(registry.get('claude'))).toBe(true);
  });

  it('preserves prototype methods while snapshotting capabilities', () => {
    class ManagedArtifacts {
      readonly kind = 'managed' as const;

      async discardArtifacts() {
        return { kind: 'discarded' as const };
      }
    }

    const registry = new ProviderRegistry();
    const artifacts = new ManagedArtifacts();
    registry.register(makeSpec('class-capability', { artifacts }));
    const registered = registry.get('class-capability')?.artifacts;

    expect(registered).toBeInstanceOf(ManagedArtifacts);
    expect(registered?.kind).toBe('managed');
    if (registered?.kind !== 'managed') throw new Error('managed fixture capability was lost');
    expect(registered.discardArtifacts).toBe(ManagedArtifacts.prototype.discardArtifacts);
  });

  it('rejects reserved provider names', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.register(makeSpec('wait'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('workflow'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('abort'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('backend'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_search'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_promote'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_update'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_delete'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_reindex'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo_list'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo_delete'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo_purge'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_seed'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_start'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_watch'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_participate'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_abort'))).toThrow('reserved');
  });

  it('rejects duplicate provider registrations', () => {
    const registry = new ProviderRegistry();

    registry.register(makeSpec('dup'));
    expect(() => registry.register(makeSpec('dup'))).toThrow('already registered');
  });

  it('rejects names that cannot identify a persisted binding codec', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.register(makeSpec('Uppercase'))).toThrow('stable persisted codec name');
    expect(() => registry.register(makeSpec('contains space'))).toThrow('stable persisted codec name');
    expect(() => registry.register(makeSpec('trailing-'))).toThrow('stable persisted codec name');
  });

  it('snapshots definition and codec authority before sealing', () => {
    const registry = new ProviderRegistry();
    const spec = makeSpec('stable');
    registry.register(spec);
    const components = registry.sealPersistedBindingCodecComponents();

    expect(() => Object.assign(spec, { name: 'drifted' })).toThrow();
    expect(() => Object.assign(spec, { run: async function* () {} })).toThrow();
    expect(registry.get('stable')?.name).toBe('stable');
    expect(registry.get('drifted')).toBeUndefined();
    expect(registry.sealPersistedBindingCodecComponents()).toBe(components);
    expect(components.map((entry) => entry.name)).toEqual(['provider.binding-envelope', 'provider.stable.binding']);
    expect(Object.isFrozen(components)).toBe(true);
  });

  it('preserves registration insertion order', () => {
    const registry = new ProviderRegistry();

    registry.register(makeSpec('zzz'));
    registry.register(makeSpec('aaa'));
    registry.register(makeSpec('mmm'));

    expect(providerNames(registry.getAll())).toEqual(['zzz', 'aaa', 'mmm']);
  });

  it('keeps registry state isolated per instance', () => {
    const left = new ProviderRegistry();
    const right = new ProviderRegistry();

    left.register(makeSpec('left'));
    right.register(makeSpec('right'));

    expect(providerNames(left.getAll())).toEqual(['left']);
    expect(providerNames(right.getAll())).toEqual(['right']);
  });

  it('returns empty state before any registration', () => {
    const registry = new ProviderRegistry();

    expect(registry.getAll()).toEqual([]);
    expect(registry.get('codex')).toBeUndefined();
  });
});
