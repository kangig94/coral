import type { KbRuntime } from '../kb/contract.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { RuntimeBinding } from '../runtime/binding.js';
import type { Disposable, Runtime } from '../runtime/ports.js';
import type { ConsumerHandle, ConsumerRegistration } from '../store/consumer-contract.js';
import type { ExpansionHost } from './contract.js';
import { decorateDispose } from './scope.js';

// Narrow port over the coordinator's ConsumerDriver. The host receives only
// the registration entrypoint, not the full coordinator class — keeps
// `src/expansion/` from importing `coordinator/` (a lower layer must not
// reach into a higher one).
export interface ConsumerDriverPort {
  register(reg: ConsumerRegistration): ConsumerHandle;
}

export interface ExpansionHostDeps {
  readonly runtime: Runtime;
  readonly kb: KbRuntime;
  readonly scope: Disposable;
  readonly id: string;
  readonly consumerDriver: ConsumerDriverPort;
}

const REGISTERED_CONSUMER_HANDLES = Symbol('expansion-registered-consumer-handles');

type ExpansionScope = Disposable & {
  [REGISTERED_CONSUMER_HANDLES]?: ConsumerHandle[];
};

function bindingNameOf<T>(binding: RuntimeBinding<T>, error: unknown): string {
  const fromError = error instanceof CoralSetupError ? error.context?.binding : undefined;
  return typeof fromError === 'string' && fromError.length > 0 ? fromError : binding.name;
}

export function registeredConsumerHandles(scope: Disposable): readonly ConsumerHandle[] {
  return (scope as ExpansionScope)[REGISTERED_CONSUMER_HANDLES] ?? [];
}

export function createExpansionHost(deps: ExpansionHostDeps): ExpansionHost {
  const host: ExpansionHost = {
    runtime: deps.runtime,
    kb: deps.kb,
    scope: deps.scope,
    id: deps.id,
    bind(binding, value) {
      binding.bind(value, host.scope, host.id);
    },
    require(binding) {
      try {
        return binding.read();
      } catch (error) {
        if (!(error instanceof CoralSetupError) || error.code !== 'binding_empty') {
          throw error;
        }
        const bindingName = bindingNameOf(binding, error);
        throw documentedCoralSetupError('binding_required', { binding: bindingName, requiredBy: host.id });
      }
    },
    registerConsumer(reg, scope) {
      const handle = deps.consumerDriver.register(reg);
      const expandedScope = scope as ExpansionScope;
      const handles = expandedScope[REGISTERED_CONSUMER_HANDLES] ?? [];
      handles.push(handle);
      expandedScope[REGISTERED_CONSUMER_HANDLES] = handles;
      decorateDispose(scope, () => {
        void handle.stop().catch(() => {}).then(() => handle.unregister()).catch(() => {});
      });
      return handle;
    },
  };

  return host;
}
