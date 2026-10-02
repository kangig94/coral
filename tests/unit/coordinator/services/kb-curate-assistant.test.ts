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
            idleRetirement: 'never',
          }),
        compileStableHost: (host) => ({ ...host.serverSpec, leaseMode: 'shared', idleRetirement: 'never' }),
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
});
