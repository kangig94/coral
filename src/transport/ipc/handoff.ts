// Transport-owned IPC handoff helper. Shared by both daemon-side
// `bindWithHandoff` (`src/coordinator/handoff.ts`) and CLI-side `ensure()`.
// Carries no coordinator vocabulary: any caller that wants to ask a peer
// daemon to step down uses this helper. Lives in transport because the
// shutdown contract is exactly two existing IPC methods (`transport.health`
// and `transport.shutdown`); there is no coordinator policy here.

import { createIpcClient, type IpcRequestOptions } from './client.js';

/**
 * Identity tuple proving "this incumbent is who it claims to be" — used to
 * gate signal escalation. `pid` alone is insufficient because pids wrap;
 * `processStartedAt` is the kernel-supplied second of process creation
 * (probed via `probeProcessStartedAtSeconds`).
 */
export type IncumbentIdentity = {
  pid: number;
  processStartedAt: number;
  source: 'health' | 'discovery';
};

export type DesiredIncumbentIdentity = {
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
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  status?: 'starting' | 'ok' | 'draining';
  pid?: number;
  processStartedAt?: number;
};

/**
 * Raised when the contender concludes the existing incumbent is *us* — same
 * bundle/flavor/namespace, not draining — and exiting the contender is the
 * correct action. Lifecycle translates this back into the existing
 * `BackendAlreadyRunningError` so bootstrap's "info log + exit 0" path
 * stays unchanged.
 */
export class IncumbentMatchesError extends Error {
  constructor(public readonly identity: DesiredIncumbentIdentity) {
    super('Coral backend already running');
    this.name = 'IncumbentMatchesError';
  }
}

/**
 * Raised when an absolute IPC deadline fires across connect+request+response.
 * Distinct from per-step timeout errors so callers can recognize "the helper
 * gave up because the budget is gone" rather than "the daemon answered but
 * with an error".
 */
export class IpcDeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcDeadlineExceededError';
  }
}

export function isCompatibleIncumbent(health: IncumbentHealth, desired: DesiredIncumbentIdentity): boolean {
  return (
    health.bundleHash === desired.bundleHash &&
    health.flavor === desired.flavor &&
    health.namespace === desired.namespace
  );
}

function remainingBudget(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

/**
 * One round-trip with the incumbent over its IPC socket: read `transport.health`,
 * then if the incumbent is mismatched (or unreachable) request `transport.shutdown`.
 * The whole call is bounded by a single absolute deadline; a connect that
 * succeeds just before the deadline does NOT receive a fresh full timeout.
 *
 * Returns:
 *   - `health`: last non-null health snapshot, or null if never reachable.
 *   - `verifiedIdentity`: pid+processStartedAt sourced from health, or null.
 *
 * Throws `IncumbentMatchesError` when the incumbent is compatible (same
 * bundleHash/flavor/namespace) and not draining; the contender treats this
 * as "we are redundant" rather than handoff.
 */
export async function requestIncumbentShutdown(opts: {
  socketPath: string;
  desired: DesiredIncumbentIdentity;
  timeoutMs: number;
}): Promise<{ health: IncumbentHealth | null; verifiedIdentity: IncumbentIdentity | null }> {
  const client = createIpcClient(opts.socketPath);
  const deadlineMs = Date.now() + opts.timeoutMs;
  let health: IncumbentHealth | null = null;

  if (remainingBudget(deadlineMs) > 0) {
    try {
      health = (await client.health<IncumbentHealth | null>({
        timeoutMs: remainingBudget(deadlineMs),
      })) as IncumbentHealth | null;
    } catch {
      // incumbent unresponsive on IPC but socket bound; daemon escalation handles this
    }
  }

  if (health && isCompatibleIncumbent(health, opts.desired) && health.status !== 'draining') {
    throw new IncumbentMatchesError(opts.desired);
  }

  if (remainingBudget(deadlineMs) > 0) {
    try {
      await client.shutdown<unknown>({ timeoutMs: remainingBudget(deadlineMs) });
    } catch {
      // ignore; incumbent may already be draining or unresponsive
    }
  }

  const verifiedIdentity: IncumbentIdentity | null =
    health && typeof health.pid === 'number' && typeof health.processStartedAt === 'number'
      ? { pid: health.pid, processStartedAt: health.processStartedAt, source: 'health' }
      : null;

  return { health, verifiedIdentity };
}

// Re-export for symmetry; some callers want to construct their own request
// options against an existing IpcClient.
export type { IpcRequestOptions };
