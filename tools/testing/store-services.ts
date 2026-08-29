import type {
  CoordinatorStoreServices,
  StoreServicesRef,
} from '../../src/coordinator/composition/store-services-ref.js';
import { assertTestDatabaseLocation } from './store-db-location.js';

export function setStoreServicesForTest(ref: StoreServicesRef, services: CoordinatorStoreServices): void {
  assertTestDatabaseLocation(services.storeDb);
  ref.set(services);
}
