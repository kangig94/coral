import { CoralSetupError } from './errors.js';
import type { Disposable } from './ports.js';

export interface RuntimeBinding<T> {
  binding: string;
  readonly heldBy: string | undefined;
  read(): T;
  bind(value: T, scope: Disposable, holder: string): void;
}

export function createRuntimeBinding<T>(defaultValue?: T): RuntimeBinding<T> {
  const hasDefault = arguments.length > 0;
  let bound = defaultValue;
  let heldBy: string | undefined;
  const binding: RuntimeBinding<T> = {
    binding: 'unknown',
    get heldBy() { return heldBy; },
    read() {
      if (heldBy !== undefined || hasDefault) return bound as T;
      throw Object.assign(new CoralSetupError({ code: 'binding-empty', userMessage: `Binding '${binding.binding}' is empty.`, remediation: 'Bind the required runtime capability before reading it.', context: { binding: binding.binding } }), { binding: binding.binding });
    },
    bind(value, scope, holder) {
      if (heldBy !== undefined) throw Object.assign(new CoralSetupError({ code: 'binding-occupied', userMessage: `Binding '${binding.binding}' is held by '${heldBy}'.`, remediation: `Dispose '${heldBy}' before rebinding '${binding.binding}'.`, context: { heldBy } }), { heldBy });
      bound = value;
      heldBy = holder;
      const dispose = scope[Symbol.dispose].bind(scope);
      let disposed = false;
      scope[Symbol.dispose] = () => {
        if (disposed) return;
        disposed = true;
        bound = defaultValue;
        heldBy = undefined;
        dispose();
      };
    },
  };
  return binding;
}
