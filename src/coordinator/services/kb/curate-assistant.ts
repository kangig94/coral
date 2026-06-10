import type { CurateAssistantPort } from '../../../kb/curate/assistant.js';
import { runClaudeOneShotTurn } from '../../../providers/claude/one-shot.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { LaunchCoordinator } from '../../live/admission.js';
import type { ProviderHostManager } from '../../live/provider-hosts/index.js';

export function createClaudeCurateAssistant(options: {
  readonly runtime: Runtime;
  readonly launchCoordinator: Pick<LaunchCoordinator, 'withInternalPermit'>;
  readonly providerHostManager: Pick<ProviderHostManager, 'acquireServer'>;
}): CurateAssistantPort {
  const { runtime, launchCoordinator, providerHostManager } = options;
  return {
    complete(request) {
      return launchCoordinator.withInternalPermit(
        {
          provider: 'claude',
          pool: 'curate',
          prefix: `curate-${request.purpose}`,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
        () =>
          runClaudeOneShotTurn(
            {
              storage: runtime.storage,
              env: runtime.env,
              ids: runtime.ids,
              acquireServer: (spec, acquireOptions) => providerHostManager.acquireServer(spec, acquireOptions),
            },
            {
              cwd: runtime.paths.coral.corpus.kbRoot,
              prompt: request.prompt,
              permissionMode: request.permissionMode ?? 'default',
              ...(request.model === undefined ? {} : { model: request.model }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            },
          ),
      );
    },
  };
}
