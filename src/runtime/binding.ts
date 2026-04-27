import { documentedCoralSetupError } from './errors.js';
import type { Disposable } from './ports.js';

export interface RuntimeBinding<T> {
  readonly name: string;
  readonly heldBy: string | undefined;
  read(): T;
  bind(value: T, scope: Disposable, holder: string): void;
}

export function createRuntimeBinding<T>(name: string, defaultValue?: T): RuntimeBinding<T> {
  const hasDefault = arguments.length > 1;
  let bound = defaultValue;
  let heldBy: string | undefined;
  return {
    name,
    get heldBy() { return heldBy; },
    read() {
      if (heldBy !== undefined || hasDefault) return bound as T;
      throw documentedCoralSetupError('binding_empty', { binding: name });
    },
    bind(value, scope, holder) {
      if (heldBy !== undefined) throw documentedCoralSetupError('binding_occupied', { binding: name, heldBy });
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
}
