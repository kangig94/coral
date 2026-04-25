import { readDiscoveryRecord } from '../infra/backend-discovery.js';
import type { CoordinatorDiscoveryRecord } from '../infra/backend-discovery.js';
import type { BuildFlavor } from '../infra/build-flavor.js';

export type { CoordinatorDiscoveryRecord };
export type { BuildFlavor };

export function readPassiveDiscovery(flavor: BuildFlavor): CoordinatorDiscoveryRecord | null {
  try {
    return readDiscoveryRecord(flavor);
  } catch {
    return null;
  }
}
