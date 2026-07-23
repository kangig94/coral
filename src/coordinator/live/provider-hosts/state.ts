import { createHash } from 'node:crypto';

import type { HostRef, ProviderServerSpec } from '../../../providers/contract.js';
import type { TimePort } from '../../../infra/port-types.js';
import type { ProviderServerHandle } from '../provider-server-transport.js';

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
  /** Opaque identity minted for the currently installed concrete process. */
  instanceId: string | null;
  spawnPromise: Promise<ProviderServerHandle> | null;
  /** Open and attached sessions pin the concrete process until idempotent close. */
  pinCount: number;
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
    }),
  );
}

export function hostFingerprintFromSpec(spec: ProviderServerSpec): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        identity: hostKeyFromSpec(spec),
        leaseMode: spec.leaseMode,
        idlePolicy: spec.leaseMode === 'shared' ? spec.idlePolicy : null,
      }),
    )
    .digest('hex');
}

export function hostRefFromEntry(entry: ProviderHostEntry): HostRef {
  if (entry.instanceId === null) {
    throw new Error('provider_host_reference_invalid: concrete host has no instance identity');
  }
  const identity = {
    provider: entry.spec.provider,
    fingerprint: hostFingerprintFromSpec(entry.spec),
    instanceId: entry.instanceId,
  } as const;
  if (entry.spec.leaseMode === 'shared') {
    return Object.freeze({ ...identity, leaseMode: 'shared' as const });
  }
  if (entry.jobId === undefined) {
    throw new Error('provider_host_reference_invalid: job-exclusive host has no owner');
  }
  return Object.freeze({ ...identity, leaseMode: 'job-exclusive' as const, ownerJobId: entry.jobId });
}
