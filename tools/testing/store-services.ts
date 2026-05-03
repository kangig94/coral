import { tmpdir } from 'node:os';
import type {
  CoordinatorStoreServices,
  StoreServicesRef,
} from '../../src/coordinator/composition/store-services-ref.js';

export function setStoreServicesForTest(
  ref: StoreServicesRef,
  services: CoordinatorStoreServices,
  opts: { storeDbPath: string },
): void {
  if (opts.storeDbPath !== ':memory:' && !opts.storeDbPath.startsWith(tmpdir())) {
    throw new Error(
      `setStoreServicesForTest: storeDbPath must be ':memory:' or under ${tmpdir()}; got ${opts.storeDbPath}`,
    );
  }
  ref.set(services);
}
