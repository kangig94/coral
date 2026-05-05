import type { Disposable } from '../runtime/ports.js';
import type { EngineManifest, Expansion, ExpansionHost } from './contract.js';
import { createScope } from './scope.js';

type ExpansionModule = {
  default: Expansion;
};

function disposeQuietly(scope: Disposable): void {
  try {
    scope[Symbol.dispose]();
  } catch {
    return;
  }
}

export async function loadExpansions(
  makeHost: (manifest: EngineManifest, scope: Disposable) => ExpansionHost,
  manifest: readonly EngineManifest[],
): Promise<readonly Disposable[]> {
  const scopes: Disposable[] = [];

  for (const entry of manifest) {
    const scope = createScope();

    try {
      const host = makeHost(entry, scope);
      const module = (await import(entry.specifier)) as ExpansionModule;
      await module.default(host);
      scopes.push(scope);
    } catch (error) {
      disposeQuietly(scope);
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        const loadedScope = scopes[index];
        if (loadedScope !== undefined) {
          disposeQuietly(loadedScope);
        }
      }
      throw error;
    }
  }

  return scopes;
}
