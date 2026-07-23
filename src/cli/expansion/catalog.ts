import { BUNDLED_ENGINES } from '../../expansion/bundled.js';
import type { EngineManifest } from '../../expansion/contract.js';
import { createExpansionManifestCatalog } from '../../expansion/manifest/catalog.js';
import { resolveBuildFlavor } from '../../infra/build-flavor.js';
import { serializeCoralSetupError } from '../../runtime/errors.js';
import { createRealRuntime } from '../../runtime/real.js';
import type { Runtime } from '../../runtime/ports.js';
import { openReadOnlyStoreDatabase, type ReadonlyDatabase } from '../../store/read-port.js';
import { currentCoralStoreFormat } from '../../store-format.js';

const CATALOG_UNAVAILABLE_MESSAGE = /unable to open database file/i;

function isCatalogUnavailableError(error: unknown): boolean {
  if (serializeCoralSetupError(error) !== null) {
    return false;
  }
  return error instanceof Error && CATALOG_UNAVAILABLE_MESSAGE.test(error.message);
}

export function readExpansionCatalog(runtime: Runtime): readonly EngineManifest[] {
  let db: ReadonlyDatabase | null = null;
  try {
    db = openReadOnlyStoreDatabase(runtime, { storeFormat: currentCoralStoreFormat() });
    return createExpansionManifestCatalog({ readDb: db }).listManifests();
  } catch (error) {
    if (isCatalogUnavailableError(error)) {
      return BUNDLED_ENGINES;
    }
    throw error;
  } finally {
    db?.close();
  }
}

export function readDefaultExpansionCatalog(): readonly EngineManifest[] {
  try {
    return readExpansionCatalog(createRealRuntime(resolveBuildFlavor(process.env)));
  } catch (error) {
    if (isCatalogUnavailableError(error)) {
      return BUNDLED_ENGINES;
    }
    throw error;
  }
}

export function resolveCatalogManifest(catalog: readonly EngineManifest[], name: string): EngineManifest | null {
  return catalog.find((entry) => entry.id === name) ?? null;
}
