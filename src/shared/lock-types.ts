export type LockRecord = {
  instanceId: string;
  pid: number;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  startedAt: number;
  processStartedAt?: number;
};
