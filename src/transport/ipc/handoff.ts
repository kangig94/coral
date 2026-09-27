import type { ProcessIncarnation } from '../../infra/node-process.js';
import { createRealTimePort } from '../../infra/time.js';
import { compareProductVersions } from '../../infra/product-version.js';
import { createIpcClient, IpcRpcError } from './client.js';
import type { TimePort } from '../../infra/port-types.js';

export type IncumbentIdentity = {
  pid: number;
  incarnation?: ProcessIncarnation;
  source: 'health' | 'discovery';
  instanceId?: string;
  token?: string;
  bootToken?: string;
  shutdownToken?: string;
};

export type DesiredIncumbentIdentity = {
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
};

/**
 * Subset of `HealthSnapshot` (server-ports.ts) the handoff helper actually
 * needs. Duplicated as a structural type so transport does not import from
 * `transport/server-ports` and keep the helper coordinator-neutral.
 */
export type IncumbentHealth = {
  version?: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  status?: 'starting' | 'ok' | 'draining';
  pid?: number;
  incarnation?: ProcessIncarnation;
  instanceId?: string;
};

export class IncumbentMatchesError extends Error {
  public readonly identity: DesiredIncumbentIdentity;
  constructor(identity: DesiredIncumbentIdentity) {
    super('Coral backend already running');
    this.identity = identity;
    this.name = 'IncumbentMatchesError';
  }
}

/**
 * Bundle hashes and plugin namespaces do not order versions. Equal versions cannot schedule an upgrade intent.
 */
export function incumbentOutranksContender(health: IncumbentHealth, desired: DesiredIncumbentIdentity): boolean {
  if (health.version === undefined || health.flavor !== desired.flavor) {
    return false;
  }
  return compareProductVersions(desired.version, health.version) <= 0;
}

export async function probeIncumbent(opts: {
  socketPath: string;
  timeoutMs: number;
  timePort?: TimePort;
}): Promise<IncumbentHealth | null> {
  const timePort = opts.timePort ?? createRealTimePort();
  const client = createIpcClient(opts.socketPath, timePort);
  if (opts.timeoutMs <= 0) return null;
  try {
    return await client.ping<IncumbentHealth | null>({ timeoutMs: opts.timeoutMs });
  } catch (error: unknown) {
    if (error instanceof IpcRpcError && error.code === 'too_many_ipc_connections') throw error;
    return null;
  }
}
