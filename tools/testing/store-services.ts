import { tmpdir } from 'node:os';
import type {
  CoordinatorStoreServices,
  StoreServicesRef,
} from '../../src/coordinator/composition/store-services-ref.js';

export function setStoreServicesForTest(
  ref: StoreServicesRef,
  services: CoordinatorStoreServices,
  opts: { storeDbPath: ':memory:'; tier: 'unit' | 'simulation' } | { storeDbPath: string; tier: 'integration' },
): void {
  if (opts.storeDbPath !== ':memory:') {
    if (opts.tier !== 'integration') {
      throw new Error(
        `setStoreServicesForTest: ${opts.tier} callers must pass storeDbPath: ':memory:' instead; got ${opts.storeDbPath}`,
      );
    }
    if (!opts.storeDbPath.startsWith(tmpdir())) {
      throw new Error(
        `setStoreServicesForTest: integration storeDbPath must be ':memory:' or under ${tmpdir()}; got ${opts.storeDbPath}`,
      );
    }
  }
  ref.set(services);
}
