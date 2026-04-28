import type { KbRuntime } from '../kb/contract.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { RuntimeBinding } from '../runtime/binding.js';
import type { Disposable, Runtime } from '../runtime/ports.js';
import type {
  ConsumerHandle,
  ConsumerRegistration,
  ConsumerRegistrationKind,
} from '../store/consumer-contract.js';
import type { ExpansionHost } from './contract.js';
import { decorateDispose } from './scope.js';

// Narrow port over the coordinator's ConsumerDriver. The host receives only
// the registration entrypoint, not the full coordinator class — keeps
// `src/expansion/` from importing `coordinator/` (a lower layer must not
// reach into a higher one).
export interface ConsumerDriverPort {
  register(reg: ConsumerRegistration): ConsumerHandle;
}

export type ExpansionTier = 'bundled' | 'installed';

export interface ExpansionHostDeps {
  readonly runtime: Runtime;
  readonly kb: KbRuntime;
  readonly scope: Disposable;
  readonly id: string;
  readonly tier: ExpansionTier;
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

/**
 * Derives `registrationKind` from the (tier, hasApply) triple. Engine code
 * intentionally does NOT declare `registrationKind` so the kind is bound to
 * lifecycle, not engine identity:
 *  - bundled                   → 'base'       (auto-equips at boot, owns the cursor)
 *  - installed && apply !== undefined → 'expansion'  (projection consumer)
 *  - installed && apply === undefined → 'stateless' (embedders / service consumers)
 */
function deriveRegistrationKind(tier: ExpansionTier, reg: ConsumerRegistration): ConsumerRegistrationKind {
  if (tier === 'bundled') {
    return 'base';
  }
  return reg.apply !== undefined ? 'expansion' : 'stateless';
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
      const registrationKind = deriveRegistrationKind(deps.tier, reg);
      const tierAware: ConsumerRegistration = { ...reg, registrationKind } as ConsumerRegistration;
      const handle = deps.consumerDriver.register(tierAware);
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
