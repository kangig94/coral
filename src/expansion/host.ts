import type { ConsumerDriver } from '../coordinator/consumer-driver.js';
import type { KbRuntime } from '../kb/contract.js';
import { CoralSetupError } from '../runtime/errors.js';
import type { RuntimeBinding } from '../runtime/binding.js';
import type { Disposable, Runtime } from '../runtime/ports.js';
import type { ExpansionHost } from './contract.js';

export interface ExpansionHostDeps {
  readonly runtime: Runtime;
  readonly kb: KbRuntime;
  readonly scope: Disposable;
  readonly id: string;
  readonly consumerDriver: ConsumerDriver;
}

function decorateDispose(scope: Disposable, onDispose: () => void): void {
  const dispose = scope[Symbol.dispose].bind(scope);
  let disposed = false;
  scope[Symbol.dispose] = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    onDispose();
    dispose();
  };
}

function bindingNameOf<T>(binding: RuntimeBinding<T>, error: unknown): string {
  const fromError = error instanceof CoralSetupError ? error.context?.binding : undefined;
  return typeof fromError === 'string' && fromError.length > 0 ? fromError : binding.binding;
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
        if (!(error instanceof CoralSetupError) || error.code !== 'binding-empty') {
          throw error;
        }
        const bindingName = bindingNameOf(binding, error);
        throw Object.assign(
          new CoralSetupError({
            code: 'binding-required',
            userMessage: `Binding '${bindingName}' is required by '${host.id}'.`,
            remediation: `Bind '${bindingName}' before loading '${host.id}'.`,
            context: { binding: bindingName, requiredBy: host.id },
          }),
          { binding: bindingName, requiredBy: host.id, cause: error },
        );
      }
    },
    registerConsumer(reg, scope) {
      const handle = deps.consumerDriver.register(reg);
      decorateDispose(scope, () => {
        void handle.stop().catch(() => {}).then(() => handle.unregister()).catch(() => {});
      });
      return handle;
    },
  };

  return host;
}
