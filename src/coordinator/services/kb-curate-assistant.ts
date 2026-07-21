import type { SystemProviderScope } from '../../infra/provider-scope.js';
import type { Runtime } from '../../runtime/ports.js';
import { CoralSetupError, documentedCoralSetupError } from '../../runtime/errors.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import { buildExactProviderEnv } from '../../providers/execution-context.js';
import { runClaudeOneShotTurn } from '../../providers/claude/one-shot.js';
import type { KbDaemonCurateAssistantHandler } from '../live/kb-daemon-supervisor.js';
import type { KbDaemonCurateUsageBudgetHandler } from '../live/kb-daemon-supervisor.js';
import { isUsageBudgetExhausted } from '../../kb/curate/usage-budget.js';
import { providerBindingFailureCode } from '../../providers/contracts/binding.js';

type ActiveSystemProviderRuntime = {
  readonly systemProviderScope?: SystemProviderScope;
  readonly acquireServer: Parameters<typeof runClaudeOneShotTurn>[0]['acquireServer'];
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

export function createKbCurateAssistantHandler(options: {
  readonly runtime: Runtime;
  readonly providerRegistry: ProviderBindingCatalog;
  readonly readActiveRuntime: () => ActiveSystemProviderRuntime | null;
  readonly runTurn?: typeof runClaudeOneShotTurn;
}): KbDaemonCurateAssistantHandler {
  const runTurn = options.runTurn ?? runClaudeOneShotTurn;
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
    const source = bound.credentialSource();
    if (source.provider !== 'claude') throw new Error('Claude binding produced a foreign execution source.');

    return runTurn(
      {
        storage: options.runtime.storage,
        ids: options.runtime.ids,
        providerContext: {
          source,
          brokerEnv: buildExactProviderEnv({
            baseEnv: options.runtime.env.fullSnapshot(),
            platform: options.runtime.env.platform(),
          }),
          controllerEnv: buildExactProviderEnv({
            baseEnv: options.runtime.env.fullSnapshot(),
            source,
            platform: options.runtime.env.platform(),
          }),
          projectsRoot: source.projectsRoot,
        },
        acquireServer: active.acquireServer,
      },
      {
        cwd: options.runtime.env.cwd(),
        prompt: request.prompt,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
        signal,
      },
    );
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
    const source = bound.credentialSource();
    if (source.provider !== 'claude') throw new Error('Claude binding produced a foreign execution source.');
    return isUsageBudgetExhausted({
      storage: options.runtime.storage,
      claudeConfigDir: source.configDir,
      now: options.runtime.time.now,
    });
  };
}
