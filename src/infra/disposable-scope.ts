// The disposable-scope primitive. It lives in infra, not in a domain, because it names no domain concept:
// it is `Symbol.dispose` chaining over the runtime's own `Disposable`.
// Each `createScope()` call returns a fresh `Disposable` whose `[Symbol.dispose]`
// is decorated to chain teardown work in registration order. Single home so the KB daemon lifecycle,
// which creates scopes, and the decorators that chain teardown onto them agree on the exact dispose
// semantic.

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
// run `onDispose` and the underlying dispose at most once. Used by any expansion
// that needs to chain teardown work onto a scope (e.g., closing native resources).
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
