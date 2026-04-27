import type { Disposable } from '../runtime/ports.js';
import type { BundledExpansion, Expansion, ExpansionHost } from './contract.js';

type ExpansionModule = {
  default: Expansion;
};

function createScope(): Disposable {
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

function disposeQuietly(scope: Disposable): void {
  try {
    scope[Symbol.dispose]();
  } catch {
    return;
  }
}

export async function loadExpansions(
  makeHost: (id: string, scope: Disposable) => ExpansionHost,
  manifest: readonly BundledExpansion[],
): Promise<readonly Disposable[]> {
  const scopes: Disposable[] = [];

  for (const entry of manifest) {
    const scope = createScope();

    try {
      const host = makeHost(entry.id, scope);
      const module = (await import(entry.specifier)) as ExpansionModule;
      await module.default(host);
      scopes.push(scope);
    } catch (error) {
      disposeQuietly(scope);
      for (const loadedScope of [...scopes].reverse()) {
        disposeQuietly(loadedScope);
      }
      throw error;
    }
  }

  return scopes;
}
