import type { ExpansionManifestCatalog } from '../../expansion/manifest-catalog.js';
import type { JobStore } from '../../jobs/store.js';
import { documentedCoralSetupError, type CoralSetupError } from '../../runtime/errors.js';
import type { Database } from '../../store/db.js';
import type { ConsumerDriver } from '../consumer-driver/index.js';

export interface CoordinatorStoreServices {
  storeDb: Database;
  progressStore: JobStore;
  expansionManifestCatalog: ExpansionManifestCatalog;
  consumerDriver: ConsumerDriver | null;
}

export interface StoreServicesRef {
  tryGet(): CoordinatorStoreServices | null;
  get(): CoordinatorStoreServices;
  set(services: CoordinatorStoreServices): void;
  clear(): void;
}

export function storeServicesStartupNotReadyError(): CoralSetupError {
  return documentedCoralSetupError('startup_not_ready');
}

class DefaultStoreServicesRef implements StoreServicesRef {
  #services: CoordinatorStoreServices | null = null;

  tryGet(): CoordinatorStoreServices | null {
    return this.#services;
  }

  get(): CoordinatorStoreServices {
    const services = this.#services;
    if (services === null) {
      throw storeServicesStartupNotReadyError();
    }
    return services;
  }

  set(services: CoordinatorStoreServices): void {
    if (this.#services !== null) {
      throw new Error('StoreServicesRef.set() called twice; use clear() first to reset.');
    }
    this.#services = services;
  }

  clear(): void {
    this.#services = null;
  }
}

export function createStoreServicesRef(): StoreServicesRef {
  return new DefaultStoreServicesRef();
}
