import { afterEach, describe, expect, it, vi } from 'vitest';

import { none } from '#src/providers/capability.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  createKbCurateAssistantHandler,
  createKbCurateUsageBudgetHandler,
} from '#src/coordinator/services/kb-curate-assistant.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import {
  prepareFixtureAppServerExecutionPlan,
  prepareFixtureHost,
  type FixtureExecutionPlan,
} from '#tests/helpers/scripted-provider.js';
import { TEST_SYSTEM_PROVIDER_SCOPE, withTestProfileLocation } from '#tests/helpers/provider-credentials.js';
import type { ProviderBindingFailure } from '#src/providers/contracts/binding.js';
import type { SystemProviderScope } from '#src/infra/provider-scope.js';
import type { ProviderCurationCapability } from '#src/providers/contract.js';
import { isClaudeCurationUsageBudgetExhausted } from '#src/providers/claude/usage-budget.js';

function claudeSystemScope(scope: SystemProviderScope = TEST_SYSTEM_PROVIDER_SCOPE): SystemProviderScope {
  return { ...scope, profiles: scope.profiles.filter((profile) => profile.provider === 'claude') };
}

function createClaudeRegistry(
  options: {
    readonly readinessFailure?: ProviderBindingFailure;
    readonly complete?: (
      request: Parameters<ProviderCurationCapability<FixtureProviderAccess>['prepare']>[0],
      runtime: Parameters<ProviderCurationCapability<FixtureProviderAccess>['prepare']>[1],
    ) => Promise<string>;
    readonly includeCuration?: boolean;
  } = {},
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const curation: ProviderCurationCapability<FixtureProviderAccess> = {
    prepare(request, runtime) {
      return {
        complete: () => (options.complete ?? (async () => 'curated'))(request, runtime),
      };
    },
    isUsageBudgetExhausted(runtime) {
      return isClaudeCurationUsageBudgetExhausted({
        configDir: runtime.access.root,
        runtime,
      });
    },
  };
  registry.register(
    defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
      name: 'claude',
      transport: 'app-server',
      run: async function* () {},
      prepareExecutionPlan: prepareFixtureAppServerExecutionPlan,
      appServer: {
        name: 'claude',
        planHost: (input) =>
          prepareFixtureHost(input, {
            provider: 'claude',
            command: 'claude',
            args: [],
            cwd: input.request.cwd,
            env: {},
            leaseMode: 'shared',
            idlePolicy: 'daemon',
          }),
        compileStableHost: (host) => ({ ...host.serverSpec, leaseMode: 'shared', idlePolicy: 'daemon' }),
      },
      recovery: {
        finalizeInterrupted: () => ({ kind: 'preserve' }),
        finalizeFromArtifacts: async () => ({ terminal: {} as never }),
      },
      ...(options.includeCuration === false ? {} : { curation }),
    })
      .binding(
        fixtureProviderBindingCodec(
          'claude',
          options.readinessFailure === undefined ? {} : { readinessFailure: options.readinessFailure },
        ),
      )
      .artifacts(none('test'))
      .build(),
  );
  registry.connectAppServerHost(appServerHost);
  return registry;
}

function request() {
  return {
    prompt: 'curate this',
    purpose: 'classification' as const,
    model: 'claude-test',
    permissionMode: 'default' as const,
  };
}

const appServerHost = {
  openSession: async () => ({
    session: {
      rpc: async <R>() => ({}) as R,
      subscribe: () => () => {},
      closed: new Promise<Error | void>(() => {}),
    },
    hostRef: {
      provider: 'claude',
      fingerprint: '0'.repeat(64),
      instanceId: 'instance-1',
      leaseMode: 'shared' as const,
    },
    close: () => {},
  }),
  attachSession: async () => null,
};

describe('KB curate assistant provider scope', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects before provider execution when no named system scope is configured', async () => {
    const runTurn = vi.fn(async () => 'unused');
    const handler = createKbCurateAssistantHandler({
      runtime: createRealRuntime('prod'),
      providerRegistry: createClaudeRegistry({ complete: runTurn }),
      readActiveRuntime: () => ({}),
    });

    await expect(handler(request(), { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'system_provider_scope_unconfigured',
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('binds only the configured Claude system profile independently of daemon selectors', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/daemon/claude');
    const runTurn = vi.fn(async () => 'curated');
    const systemScope = claudeSystemScope(
      withTestProfileLocation(
        TEST_SYSTEM_PROVIDER_SCOPE,
        'claude',
        '/system/claude',
      ) as typeof TEST_SYSTEM_PROVIDER_SCOPE,
    );
    const handler = createKbCurateAssistantHandler({
      runtime: createRealRuntime('prod'),
      providerRegistry: createClaudeRegistry({ complete: runTurn }),
      readActiveRuntime: () => ({
        systemProviderScope: systemScope,
      }),
    });

    await expect(handler(request(), { signal: new AbortController().signal })).resolves.toBe('curated');
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'curate this', model: 'claude-test' }),
      expect.objectContaining({
        access: {
          root: '/system/claude',
          routingEnv: { CLAUDE_CONFIG_DIR: '/system/claude' },
        },
      }),
    );
  });

  it('preserves provider-rendered readiness failures and never runs the one-shot turn', async () => {
    const runTurn = vi.fn(async () => 'unused');
    const handler = createKbCurateAssistantHandler({
      runtime: createRealRuntime('prod'),
      providerRegistry: createClaudeRegistry({
        complete: runTurn,
        readinessFailure: {
          reason: 'profile-unavailable',
          provider: 'claude',
          selector: 'configured fixture',
        },
      }),
      readActiveRuntime: () => ({
        systemProviderScope: claudeSystemScope(),
      }),
    });

    await expect(handler(request(), { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'provider_binding_profile_unavailable',
      userMessage: 'claude fixture binding failed: profile-unavailable',
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('rejects a bound provider that does not own curation execution', async () => {
    const handler = createKbCurateAssistantHandler({
      runtime: createRealRuntime('prod'),
      providerRegistry: createClaudeRegistry({ includeCuration: false }),
      readActiveRuntime: () => ({
        systemProviderScope: claudeSystemScope(),
      }),
    });

    await expect(handler(request(), { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'provider_curation_unsupported',
    });
  });

  it('reads usage only from the verified named system Claude profile', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/daemon/claude');
    const runtime = createRealRuntime('prod');
    const readFile = vi.spyOn(runtime.storage, 'readFileSync').mockImplementation((path) => {
      expect(path).toBe('/system/claude/hud/.coral-cache.json');
      return JSON.stringify({ claude: { ts: runtime.time.now(), data: { fiveHour: 75, weekly: 10 } } });
    });
    const systemScope = claudeSystemScope(
      withTestProfileLocation(
        TEST_SYSTEM_PROVIDER_SCOPE,
        'claude',
        '/system/claude',
      ) as typeof TEST_SYSTEM_PROVIDER_SCOPE,
    );
    const handler = createKbCurateUsageBudgetHandler({
      runtime,
      providerRegistry: createClaudeRegistry(),
      readActiveRuntime: () => ({ systemProviderScope: systemScope }),
    });

    await expect(handler({ signal: new AbortController().signal })).resolves.toBe(true);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('never reads a usage cache when the named system scope is absent', async () => {
    const runtime = createRealRuntime('prod');
    const readFile = vi.spyOn(runtime.storage, 'readFileSync');
    const handler = createKbCurateUsageBudgetHandler({
      runtime,
      providerRegistry: createClaudeRegistry(),
      readActiveRuntime: () => ({}),
    });

    await expect(handler({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'system_provider_scope_unconfigured',
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('never reads a usage cache when the named system profile fails readiness', async () => {
    const runtime = createRealRuntime('prod');
    const readFile = vi.spyOn(runtime.storage, 'readFileSync');
    const handler = createKbCurateUsageBudgetHandler({
      runtime,
      providerRegistry: createClaudeRegistry({
        readinessFailure: {
          reason: 'profile-unavailable',
          provider: 'claude',
          selector: 'configured fixture',
        },
      }),
      readActiveRuntime: () => ({ systemProviderScope: claudeSystemScope() }),
    });

    await expect(handler({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'provider_binding_profile_unavailable',
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('never falls back to a generic quota reader when the bound provider has no curation capability', async () => {
    const runtime = createRealRuntime('prod');
    const readFile = vi.spyOn(runtime.storage, 'readFileSync');
    const handler = createKbCurateUsageBudgetHandler({
      runtime,
      providerRegistry: createClaudeRegistry({ includeCuration: false }),
      readActiveRuntime: () => ({ systemProviderScope: claudeSystemScope() }),
    });

    await expect(handler({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'provider_curation_unsupported',
    });
    expect(readFile).not.toHaveBeenCalled();
  });
});
