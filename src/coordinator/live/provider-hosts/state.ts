import { hostFingerprintFromSpec } from '../../../providers/host-identity.js';

import type { HostRef, ProviderServerSpec } from '../../../providers/contract.js';
import type { JsonValue } from '../../../infra/json-value.js';
import type { TimePort } from '../../../infra/port-types.js';
import type {
  ContainedProviderServerHandle,
  ProviderServerFailedSpawnCleanupTerminalDisposition,
  ProviderServerFailedSpawnCleanupHold,
} from '../../../providers/app-server-transport.js';
import type { RecordedContainmentIdentity } from '../../../infra/process-containment.js';

export type HostStatsState = {
  liveControllers: number;
  activeTurns: number;
  heldControllers?: number;
};

export type ProviderHostShutdownObservedAbsent = Readonly<{ kind: 'observed-absent' }>;

export type ProviderHostShutdownHold = Readonly<{
  kind: 'provider-shutdown-held-alive' | 'provider-shutdown-held-unobservable';
  observation: 'alive' | 'unobservable';
  subject: Readonly<{ kind: 'provider-server'; pid: number }>;
  obligations: readonly JsonValue[];
  successor: Readonly<{ kind: 'accepted'; owner: string }> | null;
  retry(): Promise<ProviderHostShutdownDisposition>;
  operatorExit: Readonly<{
    kind: string;
    retry(): Promise<ProviderHostShutdownDisposition>;
  }>;
}>;

export type ProviderHostShutdownDisposition = ProviderHostShutdownObservedAbsent | ProviderHostShutdownHold;

/** Opaque identity for one live provider-host pin. */
export type PinToken = symbol;

/** Ownership metadata retained while a provider-host pin is live. */
export type ProviderHostPin =
  | Readonly<{ kind: 'acquisition'; jobId?: string }>
  | Readonly<{ kind: 'attached-session' }>;

export type ProviderHostEntry = {
  /** Concrete pool-entry key; unique for every job-exclusive process. */
  hostKey: string;
  /** Stable executable identity shared by equivalent host plans. */
  identityKey: string;
  spec: ProviderServerSpec;
  exactEnv: Readonly<Record<string, string>>;
  /** Owning job for a job-exclusive process. */
  jobId?: string;
  handle: ContainedProviderServerHandle | null;
  containment: RecordedContainmentIdentity | null;
  /** Opaque identity minted for the currently installed concrete process. */
  instanceId: string | null;
  spawnPromise: Promise<ContainedProviderServerHandle> | null;
  spawnCleanupHold: ProviderServerFailedSpawnCleanupHold | null;
  spawnCleanupDisposition: ProviderServerFailedSpawnCleanupTerminalDisposition | null;
  spawnCleanupAttempts: number;
  /** Open and attached sessions pin the concrete process until idempotent close. */
  pins: Map<PinToken, ProviderHostPin>;
  closingError: Error | null;
  closePromise: Promise<ProviderHostShutdownDisposition> | null;
  hostStats: HostStatsState | null;
  /** Either the idle-retirement deadline or the recurring outstanding-pin diagnostic deadline. */
  idleTimer: ReturnType<TimePort['setTimeout']> | null;
  disposeHostNotifications: (() => void) | null;
};

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
