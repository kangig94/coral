import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { TimePort } from '../../../infra/port-types.js';
import type { ProviderServerHandle } from '../provider-server-transport.js';

export type ProviderServerAttachment = {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (msg: { method: string; params?: Record<string, unknown> }) => void): () => void;
  closed: Promise<Error | void>;
};

export type ProviderServerWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export type HostStatsState = {
  liveControllers: number;
  activeTurns: number;
};

export type ProviderHostEntry = {
  hostKey: string;
  spec: ProviderServerSpec;
  handle: ProviderServerHandle | null;
  spawnPromise: Promise<ProviderServerHandle> | null;
  leaseHeld: boolean;
  sharedLeaseCount: number;
  waiters: ProviderServerWaiter[];
  closingError: Error | null;
  hostStats: HostStatsState | null;
  idleTimer: ReturnType<TimePort['setTimeout']> | null;
  disposeHostNotifications: (() => void) | null;
};

export function normalizedHostEnvEntries(spec: Pick<ProviderServerSpec, 'env'>): Array<[string, string]> {
  return Object.entries(spec.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

export function hostKeyFromSpec(spec: ProviderServerSpec): string {
  return JSON.stringify({
    provider: spec.provider,
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    env: normalizedHostEnvEntries(spec),
  });
}
