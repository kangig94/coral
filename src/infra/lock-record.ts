import type { BuildFlavor } from './build-flavor.js';

export type LockRecord = {
  instanceId: string;
  pid: number;
  version: string;
  bundleHash: string;
  flavor: BuildFlavor;
  startedAt: number;
  processStartedAt?: number;
};
