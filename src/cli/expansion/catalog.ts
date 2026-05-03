import { BUNDLED_ENGINES } from '../../expansion/bundled.js';
import type { EngineManifest } from '../../expansion/contract.js';
import { createExpansionManifestCatalog } from '../../expansion/manifest-catalog.js';
import { resolveBuildFlavor } from '../../infra/build-flavor.js';
import { createRealRuntime } from '../../runtime/real.js';
import type { Runtime } from '../../runtime/ports.js';
import { openReadOnlyStoreDatabase, type ReadonlyDatabase } from '../../store/read-port.js';

export function readExpansionCatalog(runtime: Runtime): readonly EngineManifest[] {
  let db: ReadonlyDatabase | null = null;
  try {
    db = openReadOnlyStoreDatabase(runtime);
    return createExpansionManifestCatalog({ readDb: db }).listManifests();
  } catch {
    return BUNDLED_ENGINES;
  } finally {
    db?.close();
  }
}

export function readDefaultExpansionCatalog(): readonly EngineManifest[] {
  try {
    return readExpansionCatalog(createRealRuntime(resolveBuildFlavor(process.env)));
  } catch {
    return BUNDLED_ENGINES;
  }
}

export function resolveCatalogManifest(catalog: readonly EngineManifest[], name: string): EngineManifest | null {
  return catalog.find((entry) => entry.id === name) ?? null;
}
