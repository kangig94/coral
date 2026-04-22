import { readDiscoveryRecord } from './discovery.js';
import type { CoordinatorDiscoveryRecord } from './discovery.js';
import type { BuildFlavor } from '../runtime/flavor.js';

export type { CoordinatorDiscoveryRecord };
export type { BuildFlavor };

export function readPassiveDiscovery(flavor: BuildFlavor): CoordinatorDiscoveryRecord | null {
  try {
    return readDiscoveryRecord(flavor);
  } catch {
    return null;
  }
}
