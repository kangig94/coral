export type LifecycleState = 'starting' | 'running' | 'draining' | 'stopped';

export type BackendServerInfo = {
  port: number;
  host: string;
  token: string;
  version: string;
  bundleHash: string;
  namespace: string;
  instanceId: string;
  startedAt: number;
};
