import type { SystemProviderScope } from '../../infra/provider-scope.js';
import type { Runtime } from '../../runtime/ports.js';
import { CoralSetupError, documentedCoralSetupError } from '../../runtime/errors.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { ProviderServerLaunch, ProviderServerLease } from '../../providers/contract.js';
import type { KbDaemonCurateAssistantHandler } from '../live/kb-daemon-supervisor.js';
import type { KbDaemonCurateUsageBudgetHandler } from '../live/kb-daemon-supervisor.js';
import { providerBindingFailureCode } from '../../providers/contracts/binding.js';

type ActiveSystemProviderRuntime = {
  readonly systemProviderScope?: SystemProviderScope;
  readonly acquireCoordinatorProviderHost: (
    launch: ProviderServerLaunch,
    options?: { signal?: AbortSignal },
  ) => Promise<ProviderServerLease>;
};

function bindingSetupError(
  registry: ProviderBindingCatalog,
  failure: Parameters<ProviderBindingCatalog['renderBindingFailure']>[0],
): CoralSetupError {
  return new CoralSetupError({
    code: providerBindingFailureCode(failure),
    userMessage: registry.renderBindingFailure(failure),
    remediation: 'Repair the configured Claude system profile before retrying KB assistant curation.',
  });
}

async function resolveClaudeSystemBinding(options: {
  scope: SystemProviderScope;
  providerRegistry: ProviderBindingCatalog;
  runtime: Runtime;
}) {
  const bound = await options.providerRegistry.bindFromScope(
    options.scope,
    'claude',
    'launch',
    options.runtime.storage,
  );
  if (!bound.ok) throw bindingSetupError(options.providerRegistry, bound.failure);
  return bound.value;
}

function requireCurationCapability(bound: Awaited<ReturnType<typeof resolveClaudeSystemBinding>>) {
  if (bound.curation !== undefined) return bound.curation;
  throw new CoralSetupError({
    code: 'provider_curation_unsupported',
    userMessage: `Provider '${bound.name}' does not support daemon-internal assistant curation.`,
    remediation: 'Configure a system provider whose bound implementation owns a curation capability.',
  });
}

export function createKbCurateAssistantHandler(options: {
  readonly runtime: Runtime;
  readonly providerRegistry: ProviderBindingCatalog;
  readonly readActiveRuntime: () => ActiveSystemProviderRuntime | null;
}): KbDaemonCurateAssistantHandler {
  return async (request, { signal }) => {
    const active = options.readActiveRuntime();
    if (active === null) throw documentedCoralSetupError('startup_not_ready');
    const scope = active.systemProviderScope;
    if (scope === undefined) {
      throw new CoralSetupError({
        code: 'system_provider_scope_unconfigured',
        userMessage: 'KB assistant curation requires a configured named system provider scope.',
        remediation: 'Configure CORAL_SYSTEM_PROVIDER_SCOPE with a named system scope containing a Claude profile.',
      });
    }
    const bound = await resolveClaudeSystemBinding({
      scope,
      providerRegistry: options.providerRegistry,
      runtime: options.runtime,
    });
    const curation = requireCurationCapability(bound);
    const prepared = curation.prepare(
      {
        cwd: options.runtime.env.cwd(),
        prompt: request.prompt,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
        signal,
      },
      {
        storage: options.runtime.storage,
        ids: options.runtime.ids,
        baseEnv: options.runtime.env.fullSnapshot(),
        platform: options.runtime.env.platform(),
      },
    );
    return prepared.complete({
      acquirePreparedServer: () =>
        active.acquireCoordinatorProviderHost(prepared.launch, signal === undefined ? undefined : { signal }),
    });
  };
}

export function createKbCurateUsageBudgetHandler(options: {
  readonly runtime: Runtime;
  readonly providerRegistry: ProviderBindingCatalog;
  readonly readActiveRuntime: () => Pick<ActiveSystemProviderRuntime, 'systemProviderScope'> | null;
}): KbDaemonCurateUsageBudgetHandler {
  return async ({ signal }) => {
    signal.throwIfAborted();
    const active = options.readActiveRuntime();
    if (active === null) throw documentedCoralSetupError('startup_not_ready');
    const scope = active.systemProviderScope;
    if (scope === undefined) {
      throw new CoralSetupError({
        code: 'system_provider_scope_unconfigured',
        userMessage: 'KB assistant curation requires a configured named system provider scope.',
        remediation: 'Configure CORAL_SYSTEM_PROVIDER_SCOPE with a named system scope containing a Claude profile.',
      });
    }
    const bound = await resolveClaudeSystemBinding({
      scope,
      providerRegistry: options.providerRegistry,
      runtime: options.runtime,
    });
    signal.throwIfAborted();
    return requireCurationCapability(bound).isUsageBudgetExhausted({
      storage: options.runtime.storage,
      now: options.runtime.time.now,
    });
  };
}
