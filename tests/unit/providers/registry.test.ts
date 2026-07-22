import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { managed, none } from '#src/providers/capability.js';
import { zodPersistedParser, zodValueParser } from '#src/providers/binding-parser.js';
import { bindingFailure, bindingSuccess } from '#src/providers/contracts/binding.js';
import type {
  ProviderArtifactCapability,
  ProviderArtifactHandleInput,
  ProviderAppServerCapability,
  ProviderImplementation,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderServerLaunch,
  ProviderServerLease,
} from '#src/providers/contract.js';
import { defineProvider, ProviderRegistry, type ProviderDefinition } from '#src/providers/registry.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import type { ProviderExecutionPlan } from '#src/providers/execution-plan.js';

type EmptyPlan = ProviderExecutionPlan<undefined, undefined, undefined>;
const TEST_PREPARATION_STORAGE = { existsSync: () => false } as const;
const TEST_APP_SERVER_LAUNCH: ProviderServerLaunch = {
  host: { provider: 'fixture', command: 'fixture', args: [], cwd: '/tmp', leaseMode: 'job-exclusive' as const },
  turnEnv: {},
};
type ProviderFacetOverrides = Partial<
  Pick<ProviderImplementation<EmptyPlan>, 'preflight' | 'recovery' | 'curation'>
> & {
  readonly appServer?: Omit<ProviderAppServerCapability<EmptyPlan>, 'compileStableHost'> & {
    readonly compileStableHost?: ProviderAppServerCapability<EmptyPlan>['compileStableHost'];
  };
  readonly artifacts?: ProviderArtifactCapability;
  readonly serverLaunch?: ProviderServerLaunch;
};

function makeSpec(name: string, overrides: ProviderFacetOverrides = {}): ProviderDefinition {
  const definition = defineProvider({
    name,
    prepareExecutionPlan: () => ({
      plan: { host: undefined, session: undefined, turn: undefined },
      ...(overrides.appServer ? { appServerTurnEnv: (overrides.serverLaunch ?? TEST_APP_SERVER_LAUNCH).turnEnv } : {}),
      prepareCliRequest: (request) => request,
    }),
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
    ...(overrides.appServer
      ? {
          appServer: {
            ...overrides.appServer,
            compileStableHost:
              overrides.appServer.compileStableHost ?? (() => (overrides.serverLaunch ?? TEST_APP_SERVER_LAUNCH).host),
          },
        }
      : {}),
    ...(overrides.recovery ? { recovery: overrides.recovery } : {}),
    ...(overrides.curation ? { curation: overrides.curation } : {}),
  })
    .binding(fixtureProviderBindingCodec(name))
    .artifacts(overrides.artifacts ?? none(`Test provider ${name} declares no provider artifacts.`))
    .build();

  return definition;
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
    acquirePreparedServer: async () => {
      throw new Error('No server expected in registry boundary test.');
    },
    continuityBridge: { checkpoint() {}, transportClosed() {} },
    kbRoot: '/kb',
  };
}

function serverLease() {
  return {
    rpc: async <R = unknown>() => ({}) as R,
    subscribe: () => () => {},
    release() {},
    closed: Promise.resolve(),
  };
}

async function invokeInterruptLeaseBoundary(
  rawLease: unknown,
  exercise: (lease: ProviderServerLease) => void | Promise<void> = () => {},
): Promise<void> {
  const registry = new ProviderRegistry();
  registry.register(
    makeSpec('negative-lease-boundary', {
      appServer: {
        name: 'negative-lease-boundary',
        subscriptionPhase: 'afterInitialize',
        interrupt: async (lease) => exercise(lease),
      },
      recovery: {
        finalizeInterrupted: () => ({ kind: 'preserve' }) as never,
        finalizeFromArtifacts: async () => ({ terminal: {} as never }),
      },
    }),
  );
  const prepared = successfulBinding(registry, 'negative-lease-boundary').prepareExecution({
    request: {} as never,
    baseEnv: {},
    storage: TEST_PREPARATION_STORAGE,
    platform: 'linux',
  });
  await prepared.appServer?.interrupt?.(rawLease as ProviderServerLease, {});
}

describe('ProviderRegistry', () => {
  it('uses one captured app-server compiler for normal, recovery, and curation host plans', () => {
    type CustomPlan = ProviderExecutionPlan<Readonly<{ cwd: string; accountRoot: string }>, undefined, undefined>;
    const compileStableHost = vi.fn((host: CustomPlan['host']): ProviderServerLaunch['host'] => ({
      provider: 'single-host-authority',
      command: 'fixture',
      args: ['app-server'],
      cwd: host.cwd,
      env: { ACCOUNT_ROOT: host.accountRoot },
      leaseMode: 'job-exclusive',
    }));
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider<CustomPlan, { root: string; routingEnv: Readonly<Record<string, string>> }>({
        name: 'single-host-authority',
        prepareExecutionPlan: (input) => ({
          plan: {
            host: {
              cwd: input.request.cwd,
              accountRoot: input.source.root,
            },
            session: undefined,
            turn: undefined,
          },
          appServerTurnEnv: input.protectedEnv ?? {},
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {},
        appServer: {
          name: 'single-host-authority',
          subscriptionPhase: 'afterInitialize',
          compileStableHost,
        },
        recovery: {
          finalizeInterrupted: () => ({ kind: 'preserve' }),
          finalizeFromArtifacts: async () => ({ terminal: {} as never }),
        },
        curation: {
          prepare: (request, runtime) => ({
            hostPlan: { cwd: request.cwd, accountRoot: runtime.source.root },
            turnEnv: {},
            complete: async () => 'curated',
          }),
          isUsageBudgetExhausted: () => false,
        },
      })
        .binding(fixtureProviderBindingCodec('single-host-authority'))
        .artifacts(none('test'))
        .build(),
    );
    const bound = successfulBinding(registry, 'single-host-authority');
    const input = {
      request: {
        action: 'exec' as const,
        sessionId: 'session-1',
        prompt: 'test',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      },
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    };

    const normal = bound.prepareExecution({
      ...input,
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'turn-only' },
    });
    const recovery = bound.appServer?.prepareStableHost(input);
    const curation = bound.curation?.prepare({ cwd: '/workspace', prompt: 'curate' }, {
      storage: TEST_PREPARATION_STORAGE,
      ids: {},
    } as never);

    expect(normal.appServer?.launch.host).toEqual(recovery?.host);
    expect(curation?.launch.host).toEqual(recovery?.host);
    expect(normal.appServer?.launch.turnEnv).toEqual({ CORAL_CHILD_PRINCIPAL_HANDLE: 'turn-only' });
    expect(curation?.launch.turnEnv).toEqual({});
    expect(compileStableHost).toHaveBeenCalledTimes(3);
    expect(compileStableHost.mock.calls[0]?.[0]).toEqual(compileStableHost.mock.calls[1]?.[0]);
    expect(compileStableHost.mock.calls[1]?.[0]).toEqual(compileStableHost.mock.calls[2]?.[0]);
  });

  it('rejects an app-server provider without provider-owned recovery interpretation', () => {
    expect(() =>
      defineProvider({
        name: 'uninterpreted',
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {},
        appServer: {
          name: 'uninterpreted',
          subscriptionPhase: 'afterInitialize',
          compileStableHost: () => TEST_APP_SERVER_LAUNCH.host,
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

    expect(registry.sealPersistedBindingCodecComponents().map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.fixture.binding',
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
            prepare: () => ({ hostPlan: undefined, turnEnv: {}, complete: async () => 'unused' }),
            isUsageBudgetExhausted: () => false,
          },
        }),
      ),
    ).toThrow("Provider 'orphan-curation' curation requires an app-server capability.");
  });

  it('closes the verified credential source inside bound curation', async () => {
    let observedSource: unknown;
    let observedRequest: unknown;
    let observedBaseEnv: unknown;
    const curation = {
      state: { result: 'curated' },
      prepare(request: unknown, runtime: { source: unknown; baseEnv: unknown }) {
        observedRequest = request;
        observedBaseEnv = runtime.baseEnv;
        observedSource = runtime.source;
        const result = this.state.result;
        return {
          hostPlan: undefined,
          turnEnv: {},
          complete: async () => result,
        };
      },
      isUsageBudgetExhausted(runtime: { source: unknown }) {
        observedSource = runtime.source;
        return false;
      },
    };
    const registry = new ProviderRegistry();
    registry.register(
      makeSpec('claude', {
        curation,
        appServer: { name: 'claude', subscriptionPhase: 'beforeInitialize' },
        recovery: {
          finalizeInterrupted: () => ({ kind: 'preserve' }),
          finalizeFromArtifacts: async () => ({ terminal: {} as never }),
        },
      }),
    );
    curation.state.result = 'retained-mutation';

    const bound = successfulBinding(registry, 'claude');
    const request = { cwd: '/kb', prompt: 'curate' };
    const baseEnv = { PATH: '/bin' };
    const prepared = bound.curation?.prepare(request, { baseEnv } as never);
    await expect(prepared?.complete({ acquirePreparedServer: async () => ({}) as never })).resolves.toBe('curated');

    expect(observedSource).toEqual({
      root: '/claude',
      routingEnv: { CLAUDE_CONFIG_DIR: '/claude' },
    });
    expect(Object.isFrozen(observedSource)).toBe(true);
    expect(bound).not.toHaveProperty('credentialSource');
    expect(observedRequest).not.toBe(request);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(observedBaseEnv).not.toBe(baseEnv);
    expect(Object.isFrozen(observedBaseEnv)).toBe(true);
    expect(Object.isFrozen(bound.curation)).toBe(true);
  });

  it('retains registered facets behind a bound provider', () => {
    const registry = new ProviderRegistry();
    const appServer = {
      name: 'claude',
      subscriptionPhase: 'beforeInitialize' as const,
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
    const bound = successfulBinding(registry, 'claude');
    const prepared = bound.prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });

    expect(prepared.appServer).toMatchObject({
      name: 'claude',
      subscriptionPhase: 'beforeInitialize',
    });
    expect(bound.recovery?.probe).toBeTypeOf('function');
    expect(bound.recovery?.finalizeInterrupted).toBeTypeOf('function');
    expect(bound.artifacts.kind).toBe('managed');
    expect(Object.isFrozen(registry.get('claude'))).toBe(true);
    expect(Object.isFrozen(bound)).toBe(true);
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
    const definition = defineProvider({
      name: 'normalized-binding',
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
      parseProfile: zodValueParser(createProfileSchema),
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
      credentialSource(binding: Binding) {
        return {
          version: 1 as const,
          provider: 'claude' as const,
          kind: 'config-dir' as const,
          configDir: binding.profile.canonicalLocation,
          projectsRoot: `${binding.profile.canonicalLocation}/projects`,
          emitConfigDir: true,
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

    let preparedSource: unknown;
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'class-codec',
        prepareExecutionPlan: (input) => {
          preparedSource = input.source;
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
      credentialSource() {
        return {
          version: 1 as const,
          provider: 'claude' as const,
          kind: 'config-dir' as const,
          configDir: '/accounts/drifted',
          projectsRoot: '/accounts/drifted/projects',
          emitConfigDir: true,
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
      expect(preparedSource).toEqual(expect.objectContaining({ provider: 'claude', configDir: '/accounts/captured' }));
    }
  });

  it('canonicalizes and deeply freezes credential authority independently from codec-owned values', () => {
    const source = {
      version: 1 as const,
      provider: 'codex' as const,
      kind: 'home' as const,
      home: '/sealed-source',
    };
    const codec = {
      ...fixtureProviderBindingCodec('sealed-source'),
      credentialSource: () => source,
    };
    let preparedSource: unknown;
    const definition = defineProvider({
      name: 'sealed-source',
      prepareExecutionPlan: (input) => {
        preparedSource = input.source;
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
    const bound = successfulBinding(registry, 'sealed-source');

    source.home = '/mutated-source';
    bound.prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    expect(preparedSource).toEqual({ version: 1, provider: 'codex', kind: 'home', home: '/sealed-source' });
    expect(Object.isFrozen(preparedSource)).toBe(true);
    expect(Reflect.set(preparedSource as object, 'home', '/caller-mutation')).toBe(false);
    expect(bound).not.toHaveProperty('credentialSource');
    expect(Object.isFrozen(bound.envelope.binding)).toBe(true);
    const binding = bound.envelope.binding as { profile: { routing: object } };
    expect(Object.isFrozen(binding.profile)).toBe(true);
    expect(Object.isFrozen(binding.profile.routing)).toBe(true);
  });

  it('snapshots nested app-server and recovery capabilities when the definition is created', async () => {
    const appServer = {
      name: 'sealed-capability',
      subscriptionPhase: 'beforeInitialize' as const,
    };
    const recovery = {
      state: { content: 'original' },
      finalizeInterrupted() {
        return this.state.content === 'original'
          ? ({ kind: 'preserve' } as const)
          : ({ kind: 'clear_non_resumable' } as const);
      },
      async finalizeFromArtifacts() {
        return {
          terminal: {
            kind: 'terminal' as const,
            terminal: { content: this.state.content, durationMs: 0, outcome: { kind: 'completed' as const } },
            diagnostics: {},
          },
        };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(makeSpec('sealed-capability', { appServer, recovery }));

    recovery.state.content = 'mutated';
    expect(Reflect.set(appServer, 'name', 'mutated')).toBe(true);
    expect(Reflect.set(recovery, 'finalizeInterrupted', () => ({ kind: 'clear_non_resumable' }))).toBe(true);

    const bound = successfulBinding(registry, 'sealed-capability');
    const prepared = bound.prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    expect(prepared.appServer?.name).toBe('sealed-capability');
    expect(prepared.appServer?.launch.host.command).toBe('fixture');
    expect(bound.recovery?.finalizeInterrupted({ resumable: true }, undefined, {})).toEqual({ kind: 'preserve' });
    expect((await bound.recovery?.finalizeFromArtifacts({} as never))?.terminal.terminal.content).toBe('original');
  });

  it('snapshots recovery receiver state and retained continuity inputs', async () => {
    let observedReceiver = false;
    let observedKnownArtifacts: readonly ProviderArtifactHandleInput[] | undefined;
    let observedProbeContinuity: Record<string, unknown> | undefined;
    let observedFinalizeProbe: { resumable: boolean; updatedContinuity?: Record<string, unknown> } | undefined;
    let observedFinalizeContinuity: Record<string, unknown> | undefined;
    let observedFinalizeContext: { preservedConversationRef?: string } | undefined;
    const recovery = {
      state: { content: 'captured-recovery' },
      async probe(_lease: unknown, continuity: Record<string, unknown>) {
        observedReceiver = this !== recovery;
        observedProbeContinuity = continuity;
        return { resumable: true };
      },
      finalizeInterrupted(
        probeResult: { resumable: boolean; updatedContinuity?: Record<string, unknown> },
        continuity: Record<string, unknown> | undefined,
        context: { preservedConversationRef?: string },
      ) {
        observedReceiver = observedReceiver && this !== recovery;
        observedFinalizeProbe = probeResult;
        observedFinalizeContinuity = continuity;
        observedFinalizeContext = context;
        return { kind: 'preserve' as const };
      },
      async finalizeFromArtifacts(options: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0]) {
        observedReceiver = observedReceiver && this !== recovery;
        observedKnownArtifacts = options.knownArtifactHandles;
        return {
          terminal: {
            kind: 'terminal' as const,
            terminal: { content: this.state.content, durationMs: 0, outcome: { kind: 'completed' as const } },
            diagnostics: {},
          },
        };
      },
    };

    const registry = new ProviderRegistry();
    registry.register(makeSpec('class-recovery', { recovery }));
    recovery.state.content = 'retained-mutation';
    const boundRecovery = successfulBinding(registry, 'class-recovery').recovery;

    const probeContinuity = { nested: { marker: 'captured' } };
    await expect(boundRecovery?.probe?.(serverLease(), probeContinuity)).resolves.toEqual({ resumable: true });
    probeContinuity.nested.marker = 'caller-mutated';
    expect(observedProbeContinuity).toEqual({ nested: { marker: 'captured' } });
    expect(Object.isFrozen(observedProbeContinuity)).toBe(true);
    expect(Object.isFrozen(observedProbeContinuity?.nested as object | undefined)).toBe(true);
    const probeResult = { resumable: true, updatedContinuity: { nested: { marker: 'captured' } } };
    const continuity = { nested: { marker: 'captured' } };
    const context = { preservedConversationRef: 'captured' };
    expect(boundRecovery?.finalizeInterrupted(probeResult, continuity, context)).toEqual({ kind: 'preserve' });
    probeResult.updatedContinuity.nested.marker = 'caller-mutated';
    continuity.nested.marker = 'caller-mutated';
    context.preservedConversationRef = 'caller-mutated';
    expect(observedFinalizeProbe).toEqual({
      resumable: true,
      updatedContinuity: { nested: { marker: 'captured' } },
    });
    expect(observedFinalizeContinuity).toEqual({ nested: { marker: 'captured' } });
    expect(observedFinalizeContext).toEqual({ preservedConversationRef: 'captured' });
    expect(Object.isFrozen(observedFinalizeProbe)).toBe(true);
    expect(Object.isFrozen(observedFinalizeContinuity)).toBe(true);
    expect(Object.isFrozen(observedFinalizeContext)).toBe(true);
    const knownArtifactHandles = [{ handle: '/captured', identity: { kind: 'transcript' } }];
    expect(
      (
        await boundRecovery?.finalizeFromArtifacts({
          knownArtifactHandles,
        } as never)
      )?.terminal.terminal.content,
    ).toBe('captured-recovery');
    knownArtifactHandles[0].handle = '/caller-mutated';
    knownArtifactHandles[0].identity.kind = 'caller-mutated';
    expect(observedKnownArtifacts).toEqual([{ handle: '/captured', identity: { kind: 'transcript' } }]);
    expect(observedKnownArtifacts).not.toBe(knownArtifactHandles);
    expect(Object.isFrozen(observedKnownArtifacts)).toBe(true);
    expect(Object.isFrozen(observedKnownArtifacts?.[0])).toBe(true);
    expect(Object.isFrozen(observedKnownArtifacts?.[0]?.identity)).toBe(true);
    expect(observedReceiver).toBe(true);
  });

  it('rejects provider sources that cannot be represented as immutable JSON data', () => {
    class PrivateSource {
      readonly root = '/private';
    }

    for (const [name, source] of [
      ['map-source', new Map([['root', '/map']])],
      ['set-source', { roots: new Set(['/set']) }],
      ['class-source', new PrivateSource()],
    ] as const) {
      const base = fixtureProviderBindingCodec(name);
      const registry = new ProviderRegistry();
      registry.register(
        defineProvider({
          name,
          prepareExecutionPlan: () => ({
            plan: { host: undefined, session: undefined, turn: undefined },
            prepareCliRequest: (request) => request,
          }),
          run: async function* () {},
        })
          .binding({ ...base, credentialSource: () => source as never })
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
      prepareExecutionPlan: () => ({
        plan: { host: undefined, session: undefined, turn: undefined },
        prepareCliRequest: (request: never) => request,
      }),
      run: async function* () {},
    });
    expect(() => defineProvider(implementation as never)).toThrow('Provider implementation must be a plain object');

    const baseImplementation = (name: string, facets: object = {}) => ({
      name,
      prepareExecutionPlan: () => ({
        plan: { host: undefined, session: undefined, turn: undefined },
        prepareCliRequest: (request: never) => request,
      }),
      run: async function* () {},
      ...facets,
    });
    const classAppServer = Object.assign(new PrivateReceiver(), {
      name: 'class-app-server',
      subscriptionPhase: 'beforeInitialize' as const,
    });
    expect(() =>
      defineProvider(baseImplementation('class-app-server', { appServer: classAppServer }) as never),
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
    expect(() => defineProvider(baseImplementation('class-curation', { curation: classCuration }) as never)).toThrow(
      'must be a plain object',
    );

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
    ).toThrow('Provider prepared execution must be a plain object');
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
      defineProvider(
        baseImplementation('getter-app-server', {
          appServer: accessor(
            { name: 'getter-app-server', subscriptionPhase: 'beforeInitialize' as const },
            'interrupt',
            async () => {},
          ),
        }) as never,
      ),
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
      defineProvider(
        baseImplementation('getter-curation', {
          curation: accessor({ isUsageBudgetExhausted: () => false }, 'complete', async () => ''),
        }) as never,
      ),
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

  it('snapshots app-server continuity and notifications before asynchronous provider observation', async () => {
    let observedInterruptContinuity: unknown;
    let observedNotification: unknown;
    const appServer = {
      name: 'app-server-boundary',
      subscriptionPhase: 'beforeInitialize' as const,
      compileStableHost: () => TEST_APP_SERVER_LAUNCH.host,
      async interrupt(_lease: unknown, continuity: unknown) {
        await Promise.resolve();
        observedInterruptContinuity = continuity;
      },
      onNotification(message: unknown) {
        observedNotification = message;
      },
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'app-server-boundary',
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          appServerTurnEnv: TEST_APP_SERVER_LAUNCH.turnEnv,
          prepareCliRequest: (request) => request,
        }),
        run: async function* () {},
        appServer,
        recovery: {
          finalizeInterrupted: () => ({ kind: 'preserve' as const }),
          finalizeFromArtifacts: async () => ({
            terminal: {
              kind: 'terminal' as const,
              terminal: { content: '', durationMs: 0, outcome: { kind: 'completed' as const } },
              diagnostics: {},
            },
          }),
        },
      })
        .binding(fixtureProviderBindingCodec('app-server-boundary'))
        .artifacts(none('no artifacts'))
        .build(),
    );
    const prepared = successfulBinding(registry, 'app-server-boundary').prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    const notification = { method: 'fixture/event', params: { nested: { marker: 'captured' } } };
    prepared.appServer?.onNotification?.(notification);
    notification.params.nested.marker = 'caller-mutated';
    const interruptContinuity = { nested: { marker: 'captured' } };
    const interruptPromise = prepared.appServer?.interrupt?.(serverLease(), interruptContinuity);
    interruptContinuity.nested.marker = 'caller-mutated';
    await interruptPromise;

    expect(observedInterruptContinuity).toEqual({ nested: { marker: 'captured' } });
    expect(observedNotification).toEqual({
      method: 'fixture/event',
      params: { nested: { marker: 'captured' } },
    });
    expect(Object.isFrozen(observedInterruptContinuity)).toBe(true);
    expect(Object.isFrozen(observedNotification)).toBe(true);
    expect(Object.isFrozen((observedNotification as { params: object }).params)).toBe(true);
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
    const exactCliEnv = { ROUTE: 'sealed' };
    const definition = defineProvider({
      name: 'single-request',
      prepareExecutionPlan: (input) => {
        preparedRequest = input.request;
        appServerRequest = input.request;
        const capturedEnv = { ...exactCliEnv };
        return {
          plan: { host: undefined, session: undefined, turn: undefined },
          appServerTurnEnv: {},
          prepareCliRequest: (cliRequest) => ({ ...cliRequest, exactEnv: { ...capturedEnv } }),
        };
      },
      run: async function* (request) {
        executedRequest = request;
      },
      appServer: {
        name: 'single-request',
        subscriptionPhase: 'afterInitialize',
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
    exactCliEnv.ROUTE = 'caller mutation';
    for await (const _event of prepared.execute(executionRuntime() as never)) {
      // Empty provider stream.
    }

    expect(prepared.execute).toHaveLength(1);
    expect(executedRequest).toBe(preparedRequest);
    expect(appServerRequest).toBe(preparedRequest);
    expect(executedRequest).toMatchObject({ prompt: 'prepared prompt', coralEnv: { ROUTING: 'prepared' } });
    expect(Object.isFrozen(executedRequest)).toBe(true);
    expect(Object.isFrozen(executedRequest?.coralEnv)).toBe(true);
    const cliRequest = prepared.prepareCliRequest({ command: 'fixture', args: [] });
    expect(cliRequest.exactEnv).toEqual({ ROUTE: 'sealed' });
    expect(Object.isFrozen(cliRequest.exactEnv)).toBe(true);
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
        });
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
      parseProfile: zodValueParser(createProfileSchema),
      persistedBinding: {
        parse: zodValueParser(createLazyBindingSchema),
        contract: { kind: 'lazy-effectful-binding-test' },
      },
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'immutable-schema',
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
    const components = registry.sealPersistedBindingCodecComponents();
    expect(components.every((component) => !Object.hasOwn(component, 'schema'))).toBe(true);
    expect(components.every((component) => Object.isFrozen(component.contract))).toBe(true);
  });

  it('snapshots lazy execution state and every prepared acquisition, continuity, and event boundary', async () => {
    const rpcParams = { nested: { route: 'captured' } };
    const checkpoint = { conversationRef: 'captured', providerContinuity: { nested: { route: 'captured' } } };
    const event = { kind: 'progress' as const, message: 'captured' };
    const rpcResult = { nested: { route: 'captured' } };
    let observedRuntime: unknown;
    let observedRpcResult: unknown;
    const definition = defineProvider({
      name: 'runtime-boundary',
      prepareExecutionPlan: () => ({
        plan: { host: undefined, session: undefined, turn: undefined },
        prepareCliRequest: (request) => request,
      }),
      run: async function* (_request, runtime) {
        observedRuntime = {
          persistedContinuity: runtime.persistedContinuity,
          equippedTools: runtime.equippedTools,
        };
        runtime.continuityBridge.checkpoint(checkpoint);
        const lease = await runtime.acquirePreparedServer();
        observedRpcResult = await lease.rpc('fixture/read', rpcParams);
        yield event;
        event.message = 'provider-retained-mutation';
      },
    })
      .binding(fixtureProviderBindingCodec('runtime-boundary'))
      .artifacts(none('no artifacts'))
      .build();
    const registry = new ProviderRegistry();
    registry.register(definition);
    const prepared = successfulBinding(registry, 'runtime-boundary').prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    const acquired: unknown[] = [];
    const rpcInputs: unknown[] = [];
    const checkpoints: unknown[] = [];
    const runtime = {
      ...executionRuntime(),
      persistedContinuity: { nested: { route: 'captured' } },
      equippedTools: [{ id: 'captured', summary: 'captured', guidance: ['captured'] }],
      acquirePreparedServer: async () => {
        acquired.push('prepared');
        return {
          rpc: async (_method: string, params: unknown) => {
            rpcInputs.push(params);
            return rpcResult;
          },
          subscribe: () => () => {},
          release() {},
          closed: Promise.resolve(),
        };
      },
      continuityBridge: {
        checkpoint(update: unknown) {
          checkpoints.push(update);
        },
        transportClosed() {},
      },
    };
    const stream = prepared.execute(runtime as never);
    runtime.persistedContinuity.nested.route = 'caller-retained-mutation';
    runtime.equippedTools[0].guidance[0] = 'caller-retained-mutation';
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    rpcParams.nested.route = 'provider-retained-mutation';
    checkpoint.providerContinuity.nested.route = 'provider-retained-mutation';
    rpcResult.nested.route = 'host-retained-mutation';
    await iterator.next();

    expect(observedRuntime).toEqual({
      persistedContinuity: { nested: { route: 'captured' } },
      equippedTools: [{ id: 'captured', summary: 'captured', guidance: ['captured'] }],
    });
    expect(acquired).toEqual(['prepared']);
    expect(rpcInputs).toEqual([{ nested: { route: 'captured' } }]);
    expect(checkpoints).toEqual([
      { conversationRef: 'captured', providerContinuity: { nested: { route: 'captured' } } },
    ]);
    expect(observedRpcResult).toEqual({ nested: { route: 'captured' } });
    expect(first.value).toEqual({ kind: 'progress', message: 'captured' });
    expect(Object.isFrozen(first.value)).toBe(true);
  });

  it('snapshots provider-owned server, recovery, and artifact outcomes', async () => {
    const serverSpec = {
      provider: 'outbound',
      command: 'fixture',
      args: ['captured'],
      cwd: '/tmp',
      leaseMode: 'shared' as const,
    };
    const probeOutcome = { resumable: true, updatedContinuity: { nested: { route: 'captured' } } };
    const recoveryOutcome = { kind: 'preserve' as const, conversationRef: 'captured' };
    const discardOutcome = { kind: 'discarded' as const, details: { route: 'captured' } };
    const registry = new ProviderRegistry();
    registry.register(
      makeSpec('outbound', {
        appServer: {
          name: 'outbound',
          subscriptionPhase: 'afterInitialize',
        },
        serverLaunch: { host: serverSpec, turnEnv: {} },
        recovery: {
          probe: async () => probeOutcome,
          finalizeInterrupted: () => recoveryOutcome as never,
          finalizeFromArtifacts: async () => ({ terminal: {} as never }),
        },
        artifacts: managed({ discardArtifacts: async () => discardOutcome }),
      }),
    );
    const bound = successfulBinding(registry, 'outbound');
    const prepared = bound.prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    const capturedSpec = prepared.appServer?.launch.host;
    const capturedProbe = await bound.recovery?.probe?.(serverLease(), {});
    const capturedRecovery = bound.recovery?.finalizeInterrupted(probeOutcome, undefined, {});
    const capturedDiscard =
      bound.artifacts.kind === 'managed'
        ? await bound.artifacts.discardArtifacts({ handles: [], runtime: {} as never })
        : undefined;
    serverSpec.args[0] = 'provider-retained-mutation';
    probeOutcome.updatedContinuity.nested.route = 'provider-retained-mutation';
    recoveryOutcome.conversationRef = 'provider-retained-mutation';
    discardOutcome.details.route = 'provider-retained-mutation';

    expect(capturedSpec?.args).toEqual(['captured']);
    expect(capturedProbe).toEqual({ resumable: true, updatedContinuity: { nested: { route: 'captured' } } });
    expect(capturedRecovery).toEqual({ kind: 'preserve', conversationRef: 'captured' });
    expect(capturedDiscard).toEqual({ kind: 'discarded', details: { route: 'captured' } });
  });

  it('normalizes interrupt and recovery leases through one retained-mutation-safe boundary', async () => {
    const rpcResult = { nested: { route: 'captured' } };
    const rpcInputs: unknown[] = [];
    let notificationHandler: ((message: unknown) => void) | undefined;
    let interruptLease: unknown;
    let probeLease: unknown;
    let observedInterruptResult: unknown;
    let observedProbeResult: unknown;
    let observedNotification: unknown;
    const interruptParams = { nested: { route: 'interrupt' } };
    const probeParams = { nested: { route: 'probe' } };
    const rawLease = {
      rpc: async (_method: string, params: unknown) => {
        rpcInputs.push(params);
        return rpcResult;
      },
      subscribe: (handler: (message: unknown) => void) => {
        notificationHandler = handler;
        return () => {};
      },
      release() {},
      closed: Promise.resolve(),
      generation: 7,
    };
    const registry = new ProviderRegistry();
    registry.register(
      makeSpec('lease-boundary', {
        appServer: {
          name: 'lease-boundary',
          subscriptionPhase: 'afterInitialize',
          async interrupt(lease) {
            interruptLease = lease;
            lease.subscribe((message) => {
              observedNotification = message;
            });
            observedInterruptResult = await lease.rpc('interrupt', interruptParams);
            interruptParams.nested.route = 'provider-retained-mutation';
          },
        },
        recovery: {
          async probe(lease) {
            probeLease = lease;
            observedProbeResult = await lease.rpc('probe', probeParams);
            probeParams.nested.route = 'provider-retained-mutation';
            return { resumable: true };
          },
          finalizeInterrupted: () => ({ kind: 'preserve' }) as never,
          finalizeFromArtifacts: async () => ({ terminal: {} as never }),
        },
      }),
    );
    const bound = successfulBinding(registry, 'lease-boundary');
    const prepared = bound.prepareExecution({
      request: {} as never,
      baseEnv: {},
      storage: TEST_PREPARATION_STORAGE,
      platform: 'linux',
    });
    await prepared.appServer?.interrupt?.(rawLease as never, {});
    rawLease.rpc = async () => ({ nested: { route: 'host-method-mutation' } });
    const notification = { method: 'fixture/event', params: { nested: { route: 'captured' } } };
    notificationHandler?.(notification);
    notification.params.nested.route = 'host-retained-mutation';
    await bound.recovery?.probe?.(rawLease as never, {});
    rpcResult.nested.route = 'host-retained-mutation';

    expect(interruptLease).toBe(probeLease);
    expect(interruptLease).not.toBe(rawLease);
    expect(rpcInputs).toEqual([{ nested: { route: 'interrupt' } }, { nested: { route: 'probe' } }]);
    expect(observedInterruptResult).toEqual({ nested: { route: 'captured' } });
    expect(observedProbeResult).toEqual({ nested: { route: 'captured' } });
    expect(observedNotification).toEqual({
      method: 'fixture/event',
      params: { nested: { route: 'captured' } },
    });
  });

  it.each([
    {
      name: 'an invalid lease shape',
      create: () => ({ lease: {}, assertUntouched: () => {} }),
      message: 'Provider interrupt lease must expose rpc, subscribe, and release data methods.',
    },
    {
      name: 'an accessor without invoking its getter',
      create: () => {
        let getterCalls = 0;
        const lease = Object.defineProperty(
          { subscribe: () => () => {}, release() {}, closed: Promise.resolve() },
          'rpc',
          {
            get: () => {
              getterCalls += 1;
              return async () => ({});
            },
          },
        );
        return { lease, assertUntouched: () => expect(getterCalls).toBe(0) };
      },
      message: 'Provider interrupt lease.rpc must be a data property.',
    },
    {
      name: 'a non-Promise closed member',
      create: () => ({
        lease: { rpc: async () => ({}), subscribe: () => () => {}, release() {}, closed: undefined },
        assertUntouched: () => {},
      }),
      message: 'Provider interrupt lease.closed must be a Promise.',
    },
  ])('rejects $name with its exact lease boundary error', async ({ create, message }) => {
    const { lease, assertUntouched } = create();
    await expect(Promise.resolve().then(() => invokeInterruptLeaseBoundary(lease))).rejects.toThrowError(
      new TypeError(message),
    );
    assertUntouched();
  });

  const asynchronousLeaseFailures: readonly {
    readonly name: string;
    readonly lease: ProviderServerLease;
    readonly exercise: (lease: ProviderServerLease) => void | Promise<void>;
    readonly message: string;
  }[] = [
    {
      name: 'a non-function unsubscribe result',
      lease: {
        rpc: async <R = unknown>() => ({}) as R,
        subscribe: () => null as never,
        release() {},
        closed: Promise.resolve(),
      },
      exercise: (lease) => {
        lease.subscribe(() => {});
      },
      message: 'Provider interrupt lease.subscribe must return an unsubscribe function.',
    },
    {
      name: 'a non-snapshot-safe RPC result',
      lease: {
        rpc: async () => new Map() as never,
        subscribe: () => () => {},
        release() {},
        closed: Promise.resolve(),
      },
      exercise: async (lease) => {
        await lease.rpc('fixture/read', {});
      },
      message: 'Provider interrupt lease RPC result must be a plain object; received a non-plain object.',
    },
  ];

  it.each(asynchronousLeaseFailures)(
    'rejects $name with its exact asynchronous lease error',
    async ({ lease, exercise, message }) => {
      await expect(invokeInterruptLeaseBoundary(lease, exercise)).rejects.toThrowError(new TypeError(message));
    },
  );

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
    await invokeInterruptLeaseBoundary(lease as ProviderServerLease, (wrapped) => {
      wrapped.subscribe(() => {});
    });

    expect(() => notify?.({ method: 'fixture/event', params: new Map() })).toThrowError(
      new TypeError(
        'Provider interrupt lease notification.params must be a plain object; received a non-plain object.',
      ),
    );
  });

  it('rejects a non-snapshot-safe yielded event with its exact asynchronous boundary error', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'negative-event-boundary',
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
    const components = registry.sealPersistedBindingCodecComponents();

    expect(() => Object.assign(spec, { name: 'drifted' })).toThrow();
    expect(() => Object.assign(spec, { run: async function* () {} })).toThrow();
    expect(registry.get('stable')?.name).toBe('stable');
    expect(registry.get('stable')).not.toHaveProperty('run');
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
