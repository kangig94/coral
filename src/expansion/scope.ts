// Shared scope primitive used by the expansion loader and lifecycle.
// Each `createScope()` call returns a fresh `Disposable` whose `[Symbol.dispose]`
// is decorated by `RuntimeBinding.bind` and `host.registerConsumer` to chain
// teardown work in registration order. Single home so the loader (`src/expansion/loader.ts`)
// and the KB child lifecycle (`src/coordinator/kb-child/expansion/lifecycle.ts`)
// agree on the exact dispose semantic.

import type { Disposable } from '../runtime/ports.js';

export function createScope(): Disposable {
  let disposed = false;
  return {
    [Symbol.dispose]() {
      if (disposed) {
        return;
      }
      disposed = true;
    },
  };
}

// Decorates a scope's `[Symbol.dispose]` so `onDispose` runs *before* the
// caller's existing dispose. Idempotent — repeated `[Symbol.dispose]()` calls
// run `onDispose` and the underlying dispose at most once. Used by
// `RuntimeBinding.bind`, `host.registerConsumer`, and any expansion that needs
// to chain teardown work onto a scope (e.g., closing native resources).
export function decorateDispose(scope: Disposable, onDispose: () => void): void {
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
