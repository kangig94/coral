import { documentedCoralSetupError } from './errors.js';
import type { Disposable } from './ports.js';

export interface RuntimeBinding<T> {
  readonly name: string;
  readonly heldBy: string | undefined;
  read(): T;
  bind(value: T, scope: Disposable, holder: string): void;
}

export function createRuntimeBinding<T>(name: string): RuntimeBinding<T> {
  let bound: T | undefined;
  let heldBy: string | undefined;
  return {
    name,
    get heldBy() {
      return heldBy;
    },
    read() {
      if (heldBy === undefined) {
        throw documentedCoralSetupError('binding_empty', { binding: name });
      }
      return bound as T;
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
        bound = undefined;
        heldBy = undefined;
        dispose();
      };
    },
  };
}
