import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { none } from '#src/providers/capability.js';
import { zodPersistedParser, zodValueParser } from '#src/providers/binding-parser.js';
import { bindingFailure, bindingSuccess } from '#src/providers/contracts/binding.js';
import type {
  ProviderArtifactCapability,
  ProviderAppServerCapability,
  ProviderAppServerImplementation,
  ProviderImplementation,
  ProviderRequest,
  ProviderServerSpec,
  AppServerTransport,
} from '#src/providers/contract.js';
import { defineProvider, ProviderRegistry, type ProviderDefinition } from '#src/providers/registry.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import type { ProviderExecutionPlan } from '#src/providers/execution-plan.js';

type EmptyPlan = ProviderExecutionPlan<undefined, undefined, undefined>;
const TEST_PREPARATION_STORAGE = { existsSync: () => false } as const;
const TEST_APP_SERVER_SPEC: ProviderServerSpec = {
  provider: 'fixture',
  command: 'fixture',
  args: [],
  cwd: '/tmp',
  leaseMode: 'job-exclusive',
};
type ProviderFacetOverrides = Partial<Pick<ProviderImplementation<EmptyPlan>, 'preflight' | 'recovery'>> & {
  readonly curation?: ProviderAppServerImplementation<EmptyPlan>['curation'];
  readonly appServer?: Omit<ProviderAppServerCapability<EmptyPlan>, 'planHost' | 'compileStableHost'> & {
    readonly planHost?: ProviderAppServerCapability<EmptyPlan>['planHost'];
    readonly compileStableHost?: ProviderAppServerCapability<EmptyPlan>['compileStableHost'];
  };
  readonly artifacts?: ProviderArtifactCapability;
  readonly serverSpec?: ProviderServerSpec;
};

function makeSpec(name: string, overrides: ProviderFacetOverrides = {}): ProviderDefinition {
  const run = async function* () {
    yield {
      kind: 'terminal' as const,
      terminal: {
        content: `${name} response`,
        durationMs: 0,
        outcome: { kind: 'completed' as const },
      },
      diagnostics: {},
    };
  };
  const facets = {
    ...(overrides.preflight ? { preflight: overrides.preflight } : {}),
    ...(overrides.recovery ? { recovery: overrides.recovery } : {}),
  };
  const artifacts = overrides.artifacts ?? none(`Test provider ${name} declares no provider artifacts.`);

  if (overrides.appServer !== undefined) {
    return defineProvider<EmptyPlan, FixtureProviderAccess>({
      name,
      transport: 'app-server',
      prepareExecutionPlan: () => ({
        session: undefined,
        turn: undefined,
      }),
      run,
      ...facets,
      ...(overrides.curation ? { curation: overrides.curation } : {}),
      appServer: {
        ...overrides.appServer,
        planHost: overrides.appServer.planHost ?? (() => undefined),
        compileStableHost:
          overrides.appServer.compileStableHost ??
          (() => overrides.serverSpec ?? { ...TEST_APP_SERVER_SPEC, provider: name }),
      },
    })
      .binding(fixtureProviderBindingCodec(name))
      .artifacts(artifacts)
      .build();
  }

  if (overrides.curation !== undefined) {
    return defineProvider<EmptyPlan, FixtureProviderAccess>({
      name,
      transport: 'app-server',
      prepareExecutionPlan: () => ({
        session: undefined,
        turn: undefined,
      }),
      run,
      ...facets,
      curation: overrides.curation,
    } as never)
      .binding(fixtureProviderBindingCodec(name))
      .artifacts(artifacts)
      .build();
  }

  return defineProvider<EmptyPlan, FixtureProviderAccess>({
    name,
    transport: 'standalone',
    prepareExecutionPlan: () => ({
      plan: { host: undefined, session: undefined, turn: undefined },
      prepareCliRequest: (request) => request,
    }),
    run,
    ...facets,
  })
    .binding(fixtureProviderBindingCodec(name))
    .artifacts(artifacts)
    .build();
}

function providerNames(providers: ProviderDefinition[]): string[] {
  return providers.map((provider) => provider.name);
}

function fixtureEnvelope(name: string) {
  return {
    provider: name,
    kind: 'profile',
    binding: {
      profile: { canonicalLocation: `/${name}`, routing: {} },
      guarantee: 'profile-only',
    },
  } as const;
}

function successfulBinding(registry: ProviderRegistry, name: string): BoundProvider {
  const result = registry.rehydrateBinding(fixtureEnvelope(name));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected binding failure: ${result.failure.reason}`);
  return result.value;
}

function executionRuntime() {
  return {
    signal: new AbortController().signal,
    runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
    time: {},
    storage: {},
    ids: {},
    jobId: 'registry-test-job',
    onAppServerWaiting() {},
    onHostRef() {},
    continuityBridge: { checkpoint() {}, transportClosed() {} },
    kbRoot: '/kb',
  };
}

async function invokeInterruptLeaseBoundary(
  rawLease: unknown,
  exercise: (lease: AppServerTransport) => void | Promise<void> = () => {},
): Promise<void> {
  const registry = new ProviderRegistry();
  registry.register(
    makeSpec('negative-lease-boundary', {
      appServer: {
        name: 'negative-lease-boundary',
        interrupt: async (lease) => {
          await exercise(lease);
          return true;
        },
      },
      recovery: {
        finalizeInterrupted: () => ({ kind: 'preserve' }) as never,
        finalizeFromArtifacts: async () => ({ terminal: {} as never }),
      },
    }),
  );
  registry.connectAppServerHost({
    openSession: async () => {
      throw new Error('not used');
    },
    attachSession: async (hostRef) => ({
      session: rawLease as AppServerTransport,
      hostRef,
      close: () => {},
    }),
  });
  const bound = successfulBinding(registry, 'negative-lease-boundary');
  await bound.appServer?.interrupt(
    {
      provider: 'negative-lease-boundary',
      fingerprint: '0'.repeat(64),
      instanceId: 'instance-1',
      leaseMode: 'shared',
    },
    {},
    {
      request: {} as ProviderRequest,
      baseEnv: {},
      platform: 'linux',
      storage: TEST_PREPARATION_STORAGE,
      jobId: 'registry-test-job',
    },
  );
}

describe('ProviderRegistry', () => {
  it('rejects an app-server provider without provider-owned recovery interpretation', () => {
    expect(() =>
      defineProvider<EmptyPlan, FixtureProviderAccess>({
        name: 'uninterpreted',
        transport: 'app-server',
        prepareExecutionPlan: () => ({
          session: undefined,
          turn: undefined,
        }),
        run: async function* () {},
        appServer: {
          name: 'uninterpreted',
          planHost: () => undefined,
          compileStableHost: () => TEST_APP_SERVER_SPEC,
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

  it('exposes execution behavior only through a bound provider', async () => {
    const registry = new ProviderRegistry();
    registry.register(makeSpec('transparent'));
    const definition = registry.get('transparent');
    const bound = successfulBinding(registry, 'transparent');
    const prepared = bound.prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });

    const events = [];
    for await (const event of prepared.execute(executionRuntime() as never)) events.push(event);

    expect(definition).toEqual({ name: 'transparent' });
    expect(definition).not.toHaveProperty('run');
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

    expect(registry.sealPersistedCodecComponents().map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.fixture.profile',
      'provider.fixture.binding',
      'provider.fixture.continuity',
    ]);
    expect(() => registry.register(makeSpec('late'))).toThrow("registry is sealed; cannot register 'late'");
    expect(registry.get('fixture')).toBeDefined();
  });

  it('keeps every execution facet off the unbound catalog definition', () => {
    const registry = new ProviderRegistry();
    const spec = makeSpec('claude');

    registry.register(spec);

    const definition = registry.get('claude');
    expect(definition).toEqual({ name: 'claude' });
    expect(definition).not.toHaveProperty('run');
    expect(definition).not.toHaveProperty('preflight');
    expect(definition).not.toHaveProperty('appServer');
    expect(definition).not.toHaveProperty('recovery');
    expect(definition).not.toHaveProperty('artifacts');
    expect(definition).not.toHaveProperty('curation');
  });

  it('fails closed when curation has no app-server capability to compile its host plan', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register(
        makeSpec('orphan-curation', {
          curation: {
            prepare: () => ({ complete: async () => 'unused' }),
            isUsageBudgetExhausted: () => false,
          },
        }),
      ),
    ).toThrow("Provider 'orphan-curation' requires an app-server capability.");
  });

  it('closes the verified credential access inside bound curation', async () => {
    let observedSource: unknown;
    let observedRequest: unknown;
    let observedBaseEnv: unknown;
    const curation = {
      state: { result: 'curated' },
      prepare(request: unknown, runtime: { access: unknown; baseEnv: unknown }) {
        observedRequest = request;
        observedBaseEnv = runtime.baseEnv;
        observedSource = runtime.access;
        const result = this.state.result;
        return {
          complete: async () => result,
        };
      },
      isUsageBudgetExhausted(runtime: { access: unknown }) {
        observedSource = runtime.access;
        return false;
      },
    };
    const registry = new ProviderRegistry();
    registry.register(
      makeSpec('claude', {
        curation,
        appServer: { name: 'claude' },
        recovery: {
          finalizeInterrupted: () => ({ kind: 'preserve' }),
          finalizeFromArtifacts: async () => ({ terminal: {} as never }),
        },
      }),
    );
    registry.connectAppServerHost({
      openSession: async () => ({
        session: { rpc: async <R>() => ({}) as R, subscribe: () => () => {}, closed: Promise.resolve() },
        hostRef: {
          provider: 'claude',
          fingerprint: '0'.repeat(64),
          instanceId: 'instance-1',
          leaseMode: 'shared',
        },
        close: () => {},
      }),
      attachSession: async () => null,
    });
    curation.state.result = 'retained-mutation';

    const bound = successfulBinding(registry, 'claude');
    const request = { cwd: '/kb', prompt: 'curate' };
    const baseEnv = { PATH: '/bin' };
    const prepared = bound.curation?.prepare(request, { baseEnv } as never);
    await expect(prepared?.complete()).resolves.toBe('curated');

    expect(observedSource).toEqual({
      root: '/claude',
      routingEnv: { CLAUDE_CONFIG_DIR: '/claude' },
    });
    expect(Object.isFrozen(observedSource)).toBe(true);
    expect(bound).not.toHaveProperty('access');
    expect(observedRequest).not.toBe(request);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(observedBaseEnv).not.toBe(baseEnv);
    expect(Object.isFrozen(observedBaseEnv)).toBe(true);
    expect(Object.isFrozen(bound.curation)).toBe(true);
  });

  it('snapshots managed artifact receiver data and methods independently from retained mutation', async () => {
    let observedReceiver = false;
    let observedHandles: readonly string[] | undefined;
    const artifacts = {
      kind: 'managed' as const,
      state: { implementation: 'captured', artifact: '/captured-artifact' },
      async discardArtifacts(options: { handles: readonly string[] }) {
        observedReceiver = this !== artifacts;
        observedHandles = options.handles;
        return { kind: 'discarded' as const, details: { implementation: this.state.implementation } };
      },
      locateArtifact() {
        observedReceiver = observedReceiver && this !== artifacts;
        return this.state.artifact;
      },
    };

    const registry = new ProviderRegistry();
    registry.register(makeSpec('class-capability', { artifacts }));
    artifacts.state.implementation = 'drifted';
    artifacts.state.artifact = '/drifted-artifact';
    artifacts.discardArtifacts = async function () {
      return { kind: 'discarded' as const, details: { implementation: 'drifted' } };
    };
    artifacts.locateArtifact = function () {
      return '/drifted-artifact';
    };
    const registered = successfulBinding(registry, 'class-capability').artifacts;

    expect(registered?.kind).toBe('managed');
    if (registered?.kind !== 'managed') throw new Error('managed fixture capability was lost');
    const handles = ['/captured-artifact'];
    await expect(registered.discardArtifacts({ handles, runtime: {} as never })).resolves.toEqual({
      kind: 'discarded',
      details: { implementation: 'captured' },
    });
    handles[0] = '/caller-mutated-artifact';
    expect(observedHandles).toEqual(['/captured-artifact']);
    expect(observedHandles).not.toBe(handles);
    expect(Object.isFrozen(observedHandles)).toBe(true);
    expect(registered.locateArtifact?.({ conversationRef: 'conversation', runtime: {} as never })).toBe(
      '/captured-artifact',
    );
    expect(observedReceiver).toBe(true);
  });

  it('normalizes fresh and persisted bindings through the same provider codec boundary', async () => {
    const base = fixtureProviderBindingCodec('normalized-binding');
    if (base.bindingKind !== 'profile') throw new Error('normalized binding fixture must be profile-bound');
    const codec = {
      ...base,
      persistedBinding: {
        contract: { kind: 'canonicalize-normalized-provider-binding' },
        parse(raw: unknown) {
          const parsed = base.persistedBinding.parse(raw);
          return parsed.success
            ? {
                success: true as const,
                data: {
                  ...parsed.data,
                  profile: {
                    ...parsed.data.profile,
                    canonicalLocation: `${parsed.data.profile.canonicalLocation}/canonical`,
                  },
                },
              }
            : parsed;
        },
      },
    };
    const definition = defineProvider<EmptyPlan, FixtureProviderAccess>({
      name: 'normalized-binding',
      transport: 'standalone',
      prepareExecutionPlan: () => ({
        plan: { host: undefined, session: undefined, turn: undefined },
        prepareCliRequest: (request) => request,
      }),
      run: async function* () {},
    })
      .binding(codec)
      .artifacts(none('no artifacts'))
      .build();
    const registry = new ProviderRegistry();
    registry.register(definition);

    const fresh = await registry.bindProfile(
      'normalized-binding',
      {
        provider: 'normalized-binding',
        profile: { canonicalLocation: '/accounts/normalized-binding', routing: {} },
      },
      {} as never,
    );
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error(`Unexpected fresh binding failure: ${fresh.failure.reason}`);
    const persisted = registry.rehydrateBinding({
      provider: 'normalized-binding',
      kind: 'profile',
      binding: {
        profile: { canonicalLocation: '/accounts/normalized-binding', routing: {} },
        guarantee: 'profile-only',
      },
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw new Error(`Unexpected persisted binding failure: ${persisted.failure.reason}`);

    expect(fresh.value.envelope).toEqual(persisted.value.envelope);
    expect(fresh.value.envelope.binding).toEqual({
      profile: { canonicalLocation: '/accounts/normalized-binding/canonical', routing: {} },
      guarantee: 'profile-only',
    });

    const rejectingBase = fixtureProviderBindingCodec('rejected-binding');
    if (rejectingBase.bindingKind !== 'profile') throw new Error('rejected binding fixture must be profile-bound');
    const rejectingRegistry = new ProviderRegistry();
    rejectingRegistry.register(
      defineProvider({
        name: 'rejected-binding',
        transport: 'standalone',
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {},
      })
        .binding({
          ...rejectingBase,
          persistedBinding: {
            contract: { kind: 'reject-every-provider-binding' },
            parse: () => ({ success: false as const }),
          },
        })
        .artifacts(none('no artifacts'))
        .build(),
    );
    await expect(
      rejectingRegistry.bindProfile(
        'rejected-binding',
        {
          provider: 'rejected-binding',
          profile: { canonicalLocation: '/accounts/rejected-binding', routing: {} },
        },
        {} as never,
      ),
    ).resolves.toEqual({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'rejected-binding' },
    });
    expect(
      rejectingRegistry.rehydrateBinding({
        provider: 'rejected-binding',
        kind: 'profile',
        binding: {
          profile: { canonicalLocation: '/accounts/rejected-binding', routing: {} },
          guarantee: 'profile-only',
        },
      }),
    ).toEqual({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'rejected-binding' },
    });
  });

  it('captures every codec method and nested receiver value before retained mutation', async () => {
    const createSelectionSchema = () => z.object({ key: z.string() }).strict();
    const createProfileSchema = () =>
      z.object({ canonicalLocation: z.string(), routing: z.object({ marker: z.string() }).strict() }).strict();
    const createBindingSchema = () =>
      z.object({ profile: createProfileSchema(), guarantee: z.literal('profile-only') }).strict();
    type Profile = z.infer<ReturnType<typeof createProfileSchema>>;
    type Binding = z.infer<ReturnType<typeof createBindingSchema>>;

    const codec = {
      parseSelection: zodValueParser(createSelectionSchema),
      persistedProfile: zodPersistedParser(createProfileSchema),
      persistedContinuity: zodPersistedParser(() => z.record(z.string(), z.unknown())),
      persistedBinding: zodPersistedParser(createBindingSchema),
      bindingKind: 'profile' as const,
      state: { marker: 'captured' },
      captureSelection() {
        return bindingSuccess({ key: this.state.marker });
      },
      async canonicalizeProfile(selection: { key: string }) {
        return bindingSuccess({
          canonicalLocation: `/accounts/${selection.key}`,
          routing: { marker: this.state.marker },
        });
      },
      selectorLabel() {
        return `${this.state.marker} selector`;
      },
      renderFailure() {
        return `${this.state.marker} failure`;
      },
      async bindProfile(profile: Profile) {
        return bindingSuccess({ profile, guarantee: 'profile-only' as const });
      },
      async readiness(_binding: Binding, use: 'launch' | 'resume' | 'recovery') {
        return bindingSuccess({ ready: true as const, use });
      },
      access(binding: Binding) {
        return {
          configDir: binding.profile.canonicalLocation,
          projectsRoot: `${binding.profile.canonicalLocation}/projects`,
          routing: { kind: 'config-dir' as const },
        };
      },
      compareBinding(left: Binding, right: Binding) {
        return left.profile.canonicalLocation === right.profile.canonicalLocation
          ? bindingSuccess(true as const)
          : bindingFailure({ reason: 'profile-mismatch', provider: 'class-codec' });
      },
      presentBinding() {
        return `${this.state.marker} presentation`;
      },
    };

    let preparedAccess: unknown;
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'class-codec',
        transport: 'standalone',
        prepareExecutionPlan: (input) => {
          preparedAccess = input.access;
          return {
            plan: { host: undefined, session: undefined, turn: undefined },
            prepareCliRequest: (request) => request,
          };
        },
        run: async function* () {},
      })
        .binding(codec)
        .artifacts(none('no artifacts'))
        .build(),
    );
    const envelope = {
      provider: 'class-codec',
      kind: 'profile',
      binding: {
        profile: { canonicalLocation: '/accounts/captured', routing: { marker: 'captured' } },
        guarantee: 'profile-only',
      },
    };
    const alreadyBoundResult = registry.rehydrateBinding(envelope);
    expect(alreadyBoundResult.ok).toBe(true);
    if (!alreadyBoundResult.ok) throw new Error('class codec fixture failed before prototype drift');

    codec.state.marker = 'drifted';
    Object.assign(codec, {
      captureSelection() {
        return bindingSuccess({ key: 'drifted' });
      },
      async canonicalizeProfile() {
        return bindingSuccess({ canonicalLocation: '/accounts/drifted', routing: { marker: 'drifted' } });
      },
      selectorLabel() {
        return 'drifted selector';
      },
      renderFailure() {
        return 'drifted failure';
      },
      async bindProfile(profile: Profile) {
        return bindingSuccess({
          profile: { ...profile, canonicalLocation: '/accounts/drifted' },
          guarantee: 'profile-only' as const,
        });
      },
      async readiness() {
        return bindingFailure({ reason: 'identity-unavailable', provider: 'class-codec' });
      },
      access() {
        return {
          configDir: '/accounts/drifted',
          projectsRoot: '/accounts/drifted/projects',
          routing: { kind: 'config-dir' as const },
        };
      },
      compareBinding() {
        return bindingFailure({ reason: 'profile-mismatch', provider: 'class-codec' });
      },
      presentBinding() {
        return 'drifted presentation';
      },
    });

    const scope = await registry.captureScope(
      { origin: 'caller' },
      ['class-codec'],
      { env: {}, homeDir: '/home/test' },
      {} as never,
    );
    expect(scope).toEqual({
      ok: true,
      value: {
        origin: 'caller',
        profiles: [
          {
            provider: 'class-codec',
            profile: { canonicalLocation: '/accounts/captured', routing: { marker: 'captured' } },
          },
        ],
      },
    });
    if (!scope.ok) throw new Error('captured class codec scope unexpectedly failed');
    const fresh = await registry.bindFromScope(scope.value, 'class-codec', 'launch', {} as never);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error(`captured class codec fresh bind failed: ${fresh.failure.reason}`);
    const persisted = registry.rehydrateBinding(envelope);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw new Error(`captured class codec rehydrate failed: ${persisted.failure.reason}`);

    expect(registry.selectorLabel('class-codec', { key: 'captured' })).toBe('captured selector');
    expect(registry.renderBindingFailure({ reason: 'identity-unavailable', provider: 'class-codec' })).toBe(
      'captured failure',
    );
    for (const bound of [alreadyBoundResult.value, fresh.value, persisted.value]) {
      expect(bound.present()).toBe('captured presentation');
      await expect(bound.readiness('resume', {} as never)).resolves.toEqual({
        ok: true,
        value: { ready: true, use: 'resume' },
      });
      expect(bound.compareIdentity(envelope)).toEqual({ ok: true, value: true });
      bound.prepareExecution({
        request: {} as never,
        baseEnv: {},
        storage: TEST_PREPARATION_STORAGE,
        platform: 'linux',
      });
      expect(preparedAccess).toEqual(
        expect.objectContaining({ configDir: '/accounts/captured', routing: { kind: 'config-dir' } }),
      );
    }
  });

  it('canonicalizes and deeply freezes credential authority independently from codec-owned values', () => {
    const access = {
      home: '/sealed-access',
    };
    const codec = {
      ...fixtureProviderBindingCodec('sealed-access'),
      access: () => access,
    };
    let preparedAccess: unknown;
    const definition = defineProvider({
      name: 'sealed-access',
      transport: 'standalone',
      prepareExecutionPlan: (input) => {
        preparedAccess = input.access;
        return {
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        };
      },
      run: async function* () {},
    })
      .binding(codec)
      .artifacts(none('no artifacts'))
      .build();
    const registry = new ProviderRegistry();
    registry.register(definition);
    const bound = successfulBinding(registry, 'sealed-access');

    access.home = '/mutated-access';
    bound.prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    expect(preparedAccess).toEqual({ home: '/sealed-access' });
    expect(Object.isFrozen(preparedAccess)).toBe(true);
    expect(Reflect.set(preparedAccess as object, 'home', '/caller-mutation')).toBe(false);
    expect(bound).not.toHaveProperty('access');
    expect(Object.isFrozen(bound.envelope.binding)).toBe(true);
    const binding = bound.envelope.binding as { profile: { routing: object } };
    expect(Object.isFrozen(binding.profile)).toBe(true);
    expect(Object.isFrozen(binding.profile.routing)).toBe(true);
  });

  it('rejects provider access values that cannot be represented as immutable JSON data', () => {
    class PrivateAccess {
      readonly root = '/private';
    }

    for (const [name, access] of [
      ['map-access', new Map([['root', '/map']])],
      ['set-access', { roots: new Set(['/set']) }],
      ['class-access', new PrivateAccess()],
    ] as const) {
      const base = fixtureProviderBindingCodec(name);
      const registry = new ProviderRegistry();
      registry.register(
        defineProvider({
          name,
          transport: 'standalone',
          prepareExecutionPlan: () => ({
            plan: { host: undefined, session: undefined, turn: undefined },
            prepareCliRequest: (request) => request,
          }),
          run: async function* () {},
        })
          .binding({ ...base, access: () => access as never })
          .artifacts(none('no artifacts'))
          .build(),
      );

      expect(() => registry.rehydrateBinding(fixtureEnvelope(name))).toThrow('must be a plain object');
    }
  });

  it('rejects class and private-state receivers at every provider registration boundary', () => {
    class PrivateReceiver {
      readonly #state = 'private';

      privateState(): string {
        return this.#state;
      }
    }
    const implementation = Object.assign(new PrivateReceiver(), {
      name: 'class-implementation',
      transport: 'standalone' as const,
      prepareExecutionPlan: () => ({
        plan: { host: undefined, session: undefined, turn: undefined },
        prepareCliRequest: (request: never) => request,
      }),
      run: async function* () {},
    });
    expect(() => defineProvider(implementation as never)).toThrow('Provider implementation must be a plain object');

    const baseImplementation = (name: string, facets: object = {}) => ({
      name,
      transport: 'standalone' as const,
      prepareExecutionPlan: () => ({
        plan: { host: undefined, session: undefined, turn: undefined },
        prepareCliRequest: (request: never) => request,
      }),
      run: async function* () {},
      ...facets,
    });
    const classAppServer = Object.assign(new PrivateReceiver(), {
      name: 'class-app-server',
    });
    expect(() =>
      defineProvider({
        ...baseImplementation('class-app-server'),
        transport: 'app-server',
        prepareExecutionPlan: () => ({ session: undefined, turn: undefined }),
        appServer: classAppServer,
      } as never),
    ).toThrow('must be a plain object');

    const classRecovery = Object.assign(new PrivateReceiver(), {
      finalizeInterrupted: () => ({ kind: 'preserve' as const }),
      finalizeFromArtifacts: async () => ({
        terminal: {
          kind: 'terminal' as const,
          terminal: { content: '', durationMs: 0, outcome: { kind: 'completed' as const } },
          diagnostics: {},
        },
      }),
    });
    expect(() => defineProvider(baseImplementation('class-recovery', { recovery: classRecovery }) as never)).toThrow(
      'must be a plain object',
    );

    const classCuration = Object.assign(new PrivateReceiver(), {
      complete: async () => '',
      isUsageBudgetExhausted: () => false,
    });
    expect(() =>
      defineProvider({
        ...baseImplementation('class-curation'),
        transport: 'app-server',
        prepareExecutionPlan: () => ({ session: undefined, turn: undefined }),
        appServer: {
          name: 'class-curation',
          planHost: () => undefined,
          compileStableHost: () => TEST_APP_SERVER_SPEC,
        },
        recovery: {
          finalizeInterrupted: () => ({ kind: 'preserve' as const }),
          finalizeFromArtifacts: async () => ({ terminal: {} as never }),
        },
        curation: classCuration,
      } as never),
    ).toThrow('must be a plain object');

    const codecBuilder = defineProvider(baseImplementation('class-codec-rejected') as never);
    const classCodec = Object.assign(new PrivateReceiver(), fixtureProviderBindingCodec('class-codec-rejected'));
    expect(() => codecBuilder.binding(classCodec as never).artifacts(none('no artifacts'))).toThrow(
      'Provider binding codec must be a plain object',
    );

    const artifactBuilder = defineProvider(baseImplementation('class-artifact-rejected') as never).binding(
      fixtureProviderBindingCodec('class-artifact-rejected'),
    );
    const classArtifacts = Object.assign(new PrivateReceiver(), {
      kind: 'managed' as const,
      discardArtifacts: async () => ({ kind: 'discarded' as const }),
    });
    expect(() => artifactBuilder.artifacts(classArtifacts as never)).toThrow(
      'Provider artifact capability must be a plain object',
    );

    const preparedRegistry = new ProviderRegistry();
    preparedRegistry.register(
      defineProvider({
        name: 'class-prepared-rejected',
        transport: 'standalone',
        prepareExecutionPlan: () =>
          Object.assign(new PrivateReceiver(), {
            plan: { host: undefined, session: undefined, turn: undefined },
            prepareCliRequest: (request: never) => request,
          }),
        run: async function* () {},
      })
        .binding(fixtureProviderBindingCodec('class-prepared-rejected'))
        .artifacts(none('no artifacts'))
        .build(),
    );
    expect(() =>
      successfulBinding(preparedRegistry, 'class-prepared-rejected').prepareExecution({
        request: {} as never,
        baseEnv: {},
        storage: TEST_PREPARATION_STORAGE,
        platform: 'linux',
      }),
    ).toThrow('Provider prepared standalone execution must be a plain object');
  });

  it('rejects receiver accessors without executing getters at every provider boundary', () => {
    let getterCalls = 0;
    const accessor = <Value extends object, Key extends string>(target: Value, key: Key, value: unknown): Value => {
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return value;
        },
      });
      return target;
    };
    const baseImplementation = (name: string, facets: object = {}) => ({
      name,
      transport: 'standalone' as const,
      prepareExecutionPlan: () => ({
        plan: { host: undefined, session: undefined, turn: undefined },
        prepareCliRequest: (request: never) => request,
      }),
      run: async function* () {},
      ...facets,
    });

    expect(() =>
      defineProvider(
        accessor(
          {
            name: 'getter-implementation',
            transport: 'standalone',
            prepareExecutionPlan: () => ({
              plan: { host: undefined, session: undefined, turn: undefined },
              prepareCliRequest: (request: never) => request,
            }),
          },
          'run',
          async function* () {},
        ) as never,
      ),
    ).toThrow('must be a data property');
    expect(() =>
      defineProvider({
        ...baseImplementation('getter-app-server'),
        transport: 'app-server',
        prepareExecutionPlan: () => ({ session: undefined, turn: undefined }),
        appServer: accessor({ name: 'getter-app-server' }, 'interrupt', async () => {}),
      } as never),
    ).toThrow('must be a data property');
    expect(() =>
      defineProvider(
        baseImplementation('getter-recovery', {
          recovery: accessor(
            {
              finalizeInterrupted: () => ({ kind: 'preserve' as const }),
            },
            'finalizeFromArtifacts',
            async () => ({ terminal: {} }),
          ),
        }) as never,
      ),
    ).toThrow('must be a data property');
    expect(() =>
      defineProvider({
        ...baseImplementation('getter-curation'),
        transport: 'app-server',
        prepareExecutionPlan: () => ({ session: undefined, turn: undefined }),
        appServer: {
          name: 'getter-curation',
          planHost: () => undefined,
          compileStableHost: () => TEST_APP_SERVER_SPEC,
        },
        recovery: {
          finalizeInterrupted: () => ({ kind: 'preserve' as const }),
          finalizeFromArtifacts: async () => ({ terminal: {} as never }),
        },
        curation: accessor({ isUsageBudgetExhausted: () => false }, 'complete', async () => ''),
      } as never),
    ).toThrow('must be a data property');

    const codecBuilder = defineProvider(baseImplementation('getter-codec') as never);
    expect(() =>
      codecBuilder
        .binding(accessor({ ...fixtureProviderBindingCodec('getter-codec') }, 'presentBinding', () => '') as never)
        .artifacts(none('no artifacts')),
    ).toThrow('must be a data property');
    const artifactBuilder = defineProvider(baseImplementation('getter-artifacts') as never).binding(
      fixtureProviderBindingCodec('getter-artifacts'),
    );
    expect(() =>
      artifactBuilder.artifacts(
        accessor({ kind: 'managed' as const }, 'discardArtifacts', async () => ({ kind: 'discarded' })) as never,
      ),
    ).toThrow('must be a data property');

    const preparedRegistry = new ProviderRegistry();
    preparedRegistry.register(
      defineProvider({
        name: 'getter-prepared',
        transport: 'standalone',
        prepareExecutionPlan: () =>
          accessor({ context: undefined }, 'prepareCliRequest', (request: never) => request) as never,
        run: async function* () {},
      })
        .binding(fixtureProviderBindingCodec('getter-prepared'))
        .artifacts(none('no artifacts'))
        .build(),
    );
    expect(() =>
      successfulBinding(preparedRegistry, 'getter-prepared').prepareExecution({
        request: {} as never,
        baseEnv: {},
        storage: TEST_PREPARATION_STORAGE,
        platform: 'linux',
      }),
    ).toThrow('must be a data property');
    expect(getterCalls).toBe(0);
  });

  it('snapshots preflight environment layers before provider code observes them', async () => {
    let observedBaseEnv: Readonly<Record<string, string>> | undefined;
    let observedRequestEnv: Readonly<Record<string, string>> | undefined;
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'sealed-preflight',
        transport: 'standalone',
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {},
        async preflight(input) {
          observedBaseEnv = input.baseEnv;
          observedRequestEnv = input.requestEnv;
        },
      })
        .binding(fixtureProviderBindingCodec('sealed-preflight'))
        .artifacts(none('no artifacts'))
        .build(),
    );
    const baseEnv = { PATH: '/captured/bin' };
    const requestEnv = { REQUEST_ROUTE: 'captured' };

    await successfulBinding(registry, 'sealed-preflight').preflight({ baseEnv, requestEnv } as never);
    baseEnv.PATH = '/caller-mutated/bin';
    requestEnv.REQUEST_ROUTE = 'caller-mutated';

    expect(observedBaseEnv).toEqual({ PATH: '/captured/bin' });
    expect(observedRequestEnv).toEqual({ REQUEST_ROUTE: 'captured' });
    expect(observedBaseEnv).not.toBe(baseEnv);
    expect(observedRequestEnv).not.toBe(requestEnv);
    expect(Object.isFrozen(observedBaseEnv)).toBe(true);
    expect(Object.isFrozen(observedRequestEnv)).toBe(true);
  });

  it('snapshots implementation methods and nested receiver state independently from the definition input', async () => {
    let executedContext: unknown;
    const implementation = {
      name: 'sealed-implementation',
      transport: 'standalone' as const,
      state: { marker: 'captured' },
      prepareExecutionPlan() {
        return {
          plan: { host: { marker: this.state.marker }, session: undefined, turn: undefined },
          prepareCliRequest: (request: never) => request,
        };
      },
      async *run(_request: unknown, runtime: { executionPlan: unknown }) {
        executedContext = runtime.executionPlan;
      },
    };
    const definition = defineProvider(implementation as never)
      .binding(fixtureProviderBindingCodec('sealed-implementation'))
      .artifacts(none('no artifacts'))
      .build();
    implementation.state.marker = 'retained-mutation';
    implementation.prepareExecutionPlan = function () {
      return {
        plan: { host: { marker: 'method-mutation' }, session: undefined, turn: undefined },
        prepareCliRequest: (request: never) => request,
      };
    };
    const registry = new ProviderRegistry();
    registry.register(definition);
    const prepared = successfulBinding(registry, 'sealed-implementation').prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    for await (const _event of prepared.execute(executionRuntime() as never)) {
      // Empty provider stream.
    }

    expect(executedContext).toEqual({ host: { marker: 'captured' }, session: undefined, turn: undefined });
    expect(Object.isFrozen(executedContext)).toBe(true);
  });

  it('snapshots codec boundary data while leaving binding runtime ports atomic', async () => {
    const base = fixtureProviderBindingCodec('codec-boundary');
    if (base.bindingKind !== 'profile') throw new Error('codec boundary fixture must be profile-bound');
    let observedCaptureContext: unknown;
    let observedSelection: unknown;
    let observedProfile: unknown;
    let observedSelector: unknown;
    let observedComparedBinding: unknown;
    const codec = {
      ...base,
      captureSelection(context: unknown) {
        observedCaptureContext = context;
        return bindingSuccess({ key: 'codec-boundary' });
      },
      async canonicalizeProfile(selection: { key: string }) {
        observedSelection = selection;
        return bindingSuccess({ canonicalLocation: `/${selection.key}`, routing: {} });
      },
      async bindProfile(profile: Parameters<typeof base.bindProfile>[0]) {
        observedProfile = profile;
        return bindingSuccess({ profile, guarantee: 'profile-only' as const });
      },
      selectorLabel(selection: { key: string }) {
        observedSelector = selection;
        return selection.key;
      },
      compareBinding(_left: unknown, right: unknown) {
        observedComparedBinding = right;
        return bindingSuccess(true as const);
      },
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'codec-boundary',
        transport: 'standalone',
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {},
      })
        .binding(codec)
        .artifacts(none('no artifacts'))
        .build(),
    );
    const captureContext = { env: { ROUTE: 'captured' }, homeDir: '/home/captured' };
    registry.captureSelection('codec-boundary', captureContext);
    captureContext.env.ROUTE = 'caller-mutated';
    const selection = { provider: 'codec-boundary', selection: { key: 'codec-boundary' } };
    await registry.resolveProfile(selection, {} as never);
    selection.selection.key = 'caller-mutated';
    const profile = {
      provider: 'codec-boundary',
      profile: { canonicalLocation: '/codec-boundary', routing: {} },
    };
    const boundResult = await registry.bindProfile('codec-boundary', profile, {} as never);
    profile.profile.canonicalLocation = '/caller-mutated';
    const selector = { key: 'codec-boundary' };
    registry.selectorLabel('codec-boundary', selector);
    selector.key = 'caller-mutated';
    expect(boundResult.ok).toBe(true);
    if (!boundResult.ok) throw new Error('codec boundary binding failed');
    const comparison = {
      provider: 'codec-boundary',
      kind: 'profile',
      binding: {
        profile: { canonicalLocation: '/codec-boundary', routing: {} },
        guarantee: 'profile-only',
      },
    };
    boundResult.value.compareIdentity(comparison);
    Reflect.set(comparison.binding.profile, 'canonicalLocation', '/caller-mutated');

    expect(observedCaptureContext).toEqual({ env: { ROUTE: 'captured' }, homeDir: '/home/captured' });
    expect(observedSelection).toEqual({ key: 'codec-boundary' });
    expect(observedProfile).toEqual({ canonicalLocation: '/codec-boundary', routing: {} });
    expect(observedSelector).toEqual({ key: 'codec-boundary' });
    expect(observedComparedBinding).toEqual({
      profile: { canonicalLocation: '/codec-boundary', routing: {} },
      guarantee: 'profile-only',
    });
    for (const observed of [
      observedCaptureContext,
      (observedCaptureContext as { env: object }).env,
      observedSelection,
      observedProfile,
      observedSelector,
      observedComparedBinding,
    ]) {
      expect(Object.isFrozen(observed)).toBe(true);
    }
  });

  it('seals prepared execution receiver data, plan, and CLI requests against retained mutation', async () => {
    let returnedPrepared:
      | {
          plan: { host: { route: string }; session: undefined; turn: undefined };
          prepareCliRequest(request: {
            command: string;
            args: string[];
            extraEnv?: Record<string, string>;
            exactEnv?: Record<string, string>;
          }): { command: string; args: string[]; extraEnv?: Record<string, string>; exactEnv?: Record<string, string> };
        }
      | undefined;
    let observedCliInput:
      | { args: string[]; extraEnv?: Record<string, string>; exactEnv?: Record<string, string> }
      | undefined;
    let returnedCliRequest:
      | { command: string; args: string[]; extraEnv?: Record<string, string>; exactEnv?: Record<string, string> }
      | undefined;
    let executedContext: unknown;

    const makePreparedExecution = () => ({
      plan: { host: { route: 'captured' }, session: undefined, turn: undefined },
      prepareCliRequest(request: {
        command: string;
        args: string[];
        extraEnv?: Record<string, string>;
        exactEnv?: Record<string, string>;
      }) {
        observedCliInput = request;
        returnedCliRequest = {
          ...request,
          args: [...request.args, this.plan.host.route],
          extraEnv: { ...(request.extraEnv ?? {}), PREPARED: this.plan.host.route },
          exactEnv: { ...(request.exactEnv ?? {}), ROUTE: this.plan.host.route },
        };
        return returnedCliRequest;
      },
    });

    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'sealed-prepared',
        transport: 'standalone',
        prepareExecutionPlan: () => {
          returnedPrepared = makePreparedExecution();
          return returnedPrepared;
        },
        run: async function* (_request, runtime) {
          executedContext = runtime.executionPlan;
        },
      })
        .binding(fixtureProviderBindingCodec('sealed-prepared'))
        .artifacts(none('no artifacts'))
        .build(),
    );
    const prepared = successfulBinding(registry, 'sealed-prepared').prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    if (prepared.kind !== 'standalone') throw new Error('Expected standalone prepared execution.');
    returnedPrepared!.prepareCliRequest = function (request) {
      return { ...request, args: ['prototype-drift'], exactEnv: { ROUTE: 'prototype-drift' } };
    };
    returnedPrepared!.plan.host.route = 'retained-mutation';
    const input = {
      command: 'fixture',
      args: ['captured-arg'],
      extraEnv: { INPUT: 'captured' },
      exactEnv: { EXACT: 'captured' },
    };
    const cliRequest = prepared.prepareCliRequest(input);
    input.args[0] = 'caller-mutated';
    input.extraEnv.INPUT = 'caller-mutated';
    input.exactEnv.EXACT = 'caller-mutated';
    returnedCliRequest!.args[0] = 'provider-retained-mutation';
    returnedCliRequest!.extraEnv!.PREPARED = 'provider-retained-mutation';
    returnedCliRequest!.exactEnv!.ROUTE = 'provider-retained-mutation';
    for await (const _event of prepared.execute(executionRuntime() as never)) {
      // Empty provider stream.
    }

    expect(cliRequest).toMatchObject({
      args: ['captured-arg', 'captured'],
      extraEnv: { INPUT: 'captured', PREPARED: 'captured' },
      exactEnv: { EXACT: 'captured', ROUTE: 'captured' },
    });
    expect(Object.isFrozen(observedCliInput)).toBe(true);
    expect(Object.isFrozen(observedCliInput?.args)).toBe(true);
    expect(Object.isFrozen(observedCliInput?.extraEnv)).toBe(true);
    expect(Object.isFrozen(observedCliInput?.exactEnv)).toBe(true);
    expect(Object.isFrozen(cliRequest)).toBe(true);
    expect(Object.isFrozen(cliRequest.args)).toBe(true);
    expect(Object.isFrozen(cliRequest.extraEnv)).toBe(true);
    expect(Object.isFrozen(cliRequest.exactEnv)).toBe(true);
    expect(executedContext).toEqual({ host: { route: 'captured' }, session: undefined, turn: undefined });
    expect(executedContext).not.toBe(returnedPrepared!.plan);
    expect(Object.isFrozen(executedContext)).toBe(true);
  });

  it('executes exactly the request captured by preparation', async () => {
    let preparedRequest: ProviderRequest | undefined;
    let executedRequest: ProviderRequest | undefined;
    let appServerRequest: ProviderRequest | undefined;
    const definition = defineProvider<EmptyPlan, FixtureProviderAccess>({
      name: 'single-request',
      transport: 'app-server',
      prepareExecutionPlan: (
        input: Parameters<ProviderAppServerImplementation<EmptyPlan, FixtureProviderAccess>['prepareExecutionPlan']>[0],
      ) => {
        preparedRequest = input.request;
        appServerRequest = input.request;
        return {
          session: undefined,
          turn: undefined,
        };
      },
      run: async function* (request) {
        executedRequest = request;
      },
      appServer: {
        name: 'single-request',
        planHost: () => undefined,
        compileStableHost: () => ({
          provider: 'single-request',
          command: 'single-request',
          args: [],
          cwd: appServerRequest?.cwd ?? '/missing',
          leaseMode: 'job-exclusive' as const,
        }),
      },
      recovery: {
        finalizeInterrupted: () => ({ kind: 'preserve' }),
        finalizeFromArtifacts: async () => ({
          terminal: {
            kind: 'terminal',
            terminal: { content: '', durationMs: 0, outcome: { kind: 'completed' } },
            diagnostics: {},
          },
        }),
      },
    })
      .binding(fixtureProviderBindingCodec('single-request'))
      .artifacts(none('no artifacts'))
      .build();
    const registry = new ProviderRegistry();
    registry.register(definition);
    registry.connectAppServerHost({
      openSession: async () => ({
        session: { rpc: async <R>() => ({}) as R, subscribe: () => () => {}, closed: Promise.resolve() },
        hostRef: {
          provider: 'single-request',
          fingerprint: '0'.repeat(64),
          instanceId: 'single-request-instance',
          leaseMode: 'job-exclusive',
          ownerJobId: 'registry-test-job',
        },
        close: () => {},
      }),
      attachSession: async () => null,
    });
    const request: ProviderRequest = {
      action: 'exec',
      sessionId: 'single-request-session',
      prompt: 'prepared prompt',
      cwd: '/tmp',
      bypassPermissions: false,
      coralEnv: { ROUTING: 'prepared' },
    };
    const prepared = successfulBinding(registry, 'single-request').prepareExecution({
      request,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });

    request.prompt = 'caller mutation';
    request.coralEnv.ROUTING = 'caller mutation';
    if (prepared.kind !== 'app-server') throw new Error('Expected app-server prepared execution.');
    for await (const _event of prepared.execute(executionRuntime() as never)) {
      // Empty provider stream.
    }

    expect(prepared.execute).toHaveLength(1);
    expect(executedRequest).toBe(preparedRequest);
    expect(appServerRequest).toBe(preparedRequest);
    expect(executedRequest).toMatchObject({ prompt: 'prepared prompt', coralEnv: { ROUTING: 'prepared' } });
    expect(Object.isFrozen(executedRequest)).toBe(true);
    expect(Object.isFrozen(executedRequest?.coralEnv)).toBe(true);
    expect(prepared).not.toHaveProperty('prepareCliRequest');
  });

  it('rejects forged definition accessors by provenance without executing them', () => {
    let getterCalls = 0;
    const forged = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'forged';
      },
    });

    expect(() => new ProviderRegistry().register(forged as ProviderDefinition)).toThrow(
      'registered binding provenance',
    );
    expect(getterCalls).toBe(0);
  });

  it('keeps private parser authority stable after retained schema and codec mutation', async () => {
    let refinementCalls = 0;
    let transformCalls = 0;
    let lazyGetterCalls = 0;
    const base = fixtureProviderBindingCodec('immutable-schema');
    if (base.bindingKind !== 'profile') throw new Error('immutable schema fixture must be profile-bound');
    const createSelectionSchema = () =>
      z
        .object({
          key: z.string().refine((value) => {
            refinementCalls += 1;
            return value.length > 0;
          }),
        })
        .strict();
    const createProfileSchema = () =>
      z
        .object({
          canonicalLocation: z.string(),
          routing: z.object({}).strict(),
        })
        .strict()
        .transform((profile) => {
          transformCalls += 1;
          return profile;
        })
        .describe('immutable-profile-transform');
    const createLazyBindingSchema = () =>
      z.lazy(() => {
        lazyGetterCalls += 1;
        return z.object({ profile: createProfileSchema(), guarantee: z.literal('profile-only') }).strict();
      });
    const retainedSelectionSchema = createSelectionSchema();
    const retainedProfileSchema = createProfileSchema();
    const retainedLazyBindingSchema = createLazyBindingSchema();
    const codec = {
      ...base,
      parseSelection: zodValueParser(createSelectionSchema),
      persistedProfile: zodPersistedParser(createProfileSchema),
      persistedContinuity: zodPersistedParser(() => z.record(z.string(), z.unknown())),
      persistedBinding: {
        parse: zodValueParser(createLazyBindingSchema),
        contract: { kind: 'lazy-effectful-binding-test' },
      },
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'immutable-schema',
        transport: 'standalone',
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {},
      })
        .binding(codec)
        .artifacts(none('no artifacts'))
        .build(),
    );

    expect({ refinementCalls, transformCalls, lazyGetterCalls }).toEqual({
      refinementCalls: 0,
      transformCalls: 0,
      lazyGetterCalls: 0,
    });

    Reflect.set(retainedSelectionSchema._def, 'shape', () => ({ key: z.number() }));
    Reflect.set(retainedProfileSchema._def.schema._def, 'shape', () => ({ canonicalLocation: z.number() }));
    Reflect.set(retainedLazyBindingSchema._def, 'getter', () => z.never());
    Reflect.set(codec, 'parseSelection', () => ({ success: true, data: { key: 'drifted' } }));
    Reflect.set(codec, 'parseProfile', () => ({ success: true, data: { canonicalLocation: 42, routing: {} } }));
    Reflect.set(codec.persistedBinding, 'parse', () => ({ success: true, data: {} }));

    const captured = registry.captureSelection('immutable-schema', { env: {}, homeDir: '/home/test' });
    expect(captured).toEqual(bindingSuccess({ provider: 'immutable-schema', selection: { key: 'immutable-schema' } }));
    if (!captured.ok) throw new Error('immutable schema selection capture failed');
    expect(registry.selectorLabel('immutable-schema', captured.value.selection)).toBe(
      'immutable-schema fixture selector',
    );
    const profile = await registry.resolveProfile(captured.value, {} as never);
    expect(profile).toEqual(
      bindingSuccess({
        provider: 'immutable-schema',
        profile: { canonicalLocation: '/immutable-schema', routing: {} },
      }),
    );
    if (!profile.ok) throw new Error('immutable schema canonicalization failed');
    expect((await registry.bindProfile('immutable-schema', profile.value, {} as never)).ok).toBe(true);
    expect(registry.rehydrateBinding(fixtureEnvelope('immutable-schema')).ok).toBe(true);
    expect(
      await registry.resolveProfile({ provider: 'immutable-schema', selection: { key: 42 } } as never, {} as never),
    ).toEqual(
      bindingFailure({
        reason: 'unsupported-selection',
        provider: 'immutable-schema',
        selector: 'immutable-schema selection',
      }),
    );
    expect(
      await registry.bindProfile(
        'immutable-schema',
        { provider: 'immutable-schema', profile: { canonicalLocation: 42, routing: {} } },
        {} as never,
      ),
    ).toEqual(
      bindingFailure({
        reason: 'profile-unavailable',
        provider: 'immutable-schema',
        selector: 'immutable-schema credential profile',
      }),
    );
    expect(
      registry.rehydrateBinding({
        ...fixtureEnvelope('immutable-schema'),
        binding: { profile: { canonicalLocation: 42, routing: {} }, guarantee: 'profile-only' },
      }).ok,
    ).toBe(false);
    expect(lazyGetterCalls).toBeGreaterThan(0);
    const components = registry.sealPersistedCodecComponents();
    expect(components.every((component) => !Object.hasOwn(component, 'schema'))).toBe(true);
    expect(components.every((component) => Object.isFrozen(component.contract))).toBe(true);
  });

  it('rejects a non-snapshot-safe lease notification with its exact boundary error', async () => {
    let notify: ((message: unknown) => void) | undefined;
    const lease = {
      rpc: async () => ({}),
      subscribe: (handler: (message: unknown) => void) => {
        notify = handler;
        return () => {};
      },
      release() {},
      closed: Promise.resolve(),
    };
    await invokeInterruptLeaseBoundary(lease as AppServerTransport, (wrapped) => {
      wrapped.subscribe(() => {});
    });

    expect(() => notify?.({ method: 'fixture/event', params: new Map() })).toThrowError(
      new TypeError(
        'Provider interrupt session notification.params must be a plain object; received a non-plain object.',
      ),
    );
  });

  it('rejects a non-snapshot-safe yielded event with its exact asynchronous boundary error', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'negative-event-boundary',
        transport: 'standalone',
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {
          yield new Map() as never;
        },
      })
        .binding(fixtureProviderBindingCodec('negative-event-boundary'))
        .artifacts(none('no artifacts'))
        .build(),
    );
    const stream = successfulBinding(registry, 'negative-event-boundary')
      .prepareExecution({
        request: {} as never,
        baseEnv: {},
        storage: TEST_PREPARATION_STORAGE,
        platform: 'linux',
      })
      .execute(executionRuntime() as never);

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrowError(
      new TypeError('Provider event must be a plain object; received a non-plain object.'),
    );
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
    const components = registry.sealPersistedCodecComponents();

    expect(() => Object.assign(spec, { name: 'drifted' })).toThrow();
    expect(() => Object.assign(spec, { run: async function* () {} })).toThrow();
    expect(registry.get('stable')?.name).toBe('stable');
    expect(registry.get('stable')).not.toHaveProperty('run');
    expect(registry.get('drifted')).toBeUndefined();
    expect(registry.sealPersistedCodecComponents()).toBe(components);
    expect(components.map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.stable.profile',
      'provider.stable.binding',
      'provider.stable.continuity',
    ]);
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
