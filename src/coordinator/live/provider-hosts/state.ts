import type { ProviderServerSpec } from '../../../providers/contract.js';
import type { TimePort } from '../../../infra/port-types.js';
import type { ProviderServerHandle } from '../provider-server-transport.js';

export type ProviderServerAttachment = {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (msg: { method: string; params?: Record<string, unknown> }) => void): () => void;
  closed: Promise<Error | void>;
};

export type HostStatsState = {
  liveControllers: number;
  activeTurns: number;
};

export type ProviderHostEntry = {
  /** Concrete pool-entry key; unique for every job-exclusive process. */
  hostKey: string;
  /** Stable executable identity shared by equivalent host plans. */
  identityKey: string;
  spec: ProviderServerSpec;
  exactEnv: Readonly<Record<string, string>>;
  /** Owning job for a job-exclusive process. */
  jobId?: string;
  handle: ProviderServerHandle | null;
  spawnPromise: Promise<ProviderServerHandle> | null;
  leaseHeld: boolean;
  sharedLeaseCount: number;
  closingError: Error | null;
  closePromise: Promise<void> | null;
  hostStats: HostStatsState | null;
  idleTimer: ReturnType<TimePort['setTimeout']> | null;
  disposeHostNotifications: (() => void) | null;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function hostKeyFromSpec(spec: ProviderServerSpec): string {
  return JSON.stringify(
    canonicalValue({
      provider: spec.provider,
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: spec.env ?? {},
      initializeRequest: spec.initializeRequest ?? null,
      initializeTimeoutMs: spec.initializeTimeoutMs ?? null,
      shutdownCapability: spec.shutdownCapability ?? null,
      runtimeMetadata: spec.runtimeMetadata ?? null,
    }),
  );
}
