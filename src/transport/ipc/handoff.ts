import type { ProcessIncarnation } from '../../infra/node-process.js';
// Transport-owned IPC handoff helper. Shared by both daemon-side
// `bindWithHandoff` (`src/coordinator/handoff.ts`) and CLI-side `ensure()`.
// Carries no coordinator vocabulary: any caller that wants to ask a peer
// daemon to step down uses this helper. Lives in transport because the
// shutdown contract is exactly two IPC methods (`transport.ping`
// and `transport.shutdown`); there is no coordinator policy here.

import { createRealTimePort } from '../../infra/time.js';
import { compareProductVersions } from '../../infra/product-version.js';
import { createIpcClient } from './client.js';
import type { TimePort } from '../../infra/port-types.js';

/**
 * Identity tuple proving "this incumbent is who it claims to be" — used to
 * gate signal escalation. `pid` alone is insufficient because pids wrap;
 * `incarnation` is the kernel-supplied second of process creation
 * (probed via `probeProcessIncarnation`).
 */
export type IncumbentIdentity = {
  pid: number;
  /** Absent when the incumbent predates the token. Never required to signal: a contender verifies the
   *  pid against a baseline it observed itself. */
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

/**
 * Raised when the contender concludes the existing incumbent already
 * outranks it — matching flavor/namespace, same-or-newer product version,
 * not draining — and exiting the contender is the correct action.
 * Lifecycle translates this back into the existing `BackendAlreadyRunningError`
 * so bootstrap's "info log + exit 0" path stays unchanged.
 */
export class IncumbentMatchesError extends Error {
  public readonly identity: DesiredIncumbentIdentity;
  constructor(identity: DesiredIncumbentIdentity) {
    super('Coral backend already running');
    this.identity = identity;
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

/**
 * True when the live incumbent already covers everything the contender's own
 * build would provide, so evicting it would trade a healthy coordinator for
 * one that is not an upgrade. This is the daemon-side half of the precedence
 * rule V1.1 already applies on the CLI path (`resolveLiveIncumbentRouting` /
 * `routeLiveIncumbent` in `src/infra/backend-routing.ts`): a version
 * difference alone is never a replacement reason, and there is no arbitrary
 * tie-break at equal version — the incumbent keeps the socket. `bundleHash`
 * therefore no longer gates this decision; it identifies a build, it does
 * not order one.
 *
 * Total by construction: `compareProductVersions` cannot make both
 * directions of the same ordered pair positive, so of two contenders racing
 * for one incumbent, at most one can conclude the other side is upgradeable.
 * At equal version neither can, so both defer — an equal-version rebuild
 * with a different bundle hash converges on whichever build bound the
 * socket first instead of alternating SIGTERM/SIGKILL evictions that reset
 * the store on every lap.
 */
export function incumbentOutranksContender(health: IncumbentHealth, desired: DesiredIncumbentIdentity): boolean {
  if (health.version === undefined || health.flavor !== desired.flavor || health.namespace !== desired.namespace) {
    return false;
  }
  return compareProductVersions(desired.version, health.version) <= 0;
}

function remainingBudget(deadlineMs: number, timePort: TimePort): number {
  return Math.max(0, deadlineMs - timePort.now());
}

function isShutdownUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error) || error.cause === null || typeof error.cause !== 'object') {
    return false;
  }
  return (error.cause as Record<string, unknown>).code === 'shutdown_unauthorized';
}

/**
 * One round-trip with the incumbent over its IPC socket: read `transport.ping`,
 * then if the incumbent is mismatched (or unreachable) request `transport.shutdown`.
 * The whole call is bounded by a single absolute deadline; a connect that
 * succeeds just before the deadline does NOT receive a fresh full timeout.
 *
 * Returns:
 *   - `health`: last non-null health snapshot, or null if never reachable.
 *   - `verifiedIdentity`: pid+incarnation sourced from health, or null.
 *
 * Throws `IncumbentMatchesError` when the incumbent outranks the contender
 * (`incumbentOutranksContender`: matching flavor/namespace, same-or-newer
 * version) and is not draining; the contender treats this as "we are
 * redundant" rather than handoff.
 */
export async function requestIncumbentShutdown(opts: {
  socketPath: string;
  desired: DesiredIncumbentIdentity;
  bootToken?: string;
  timeoutMs: number;
  timePort?: TimePort;
}): Promise<{
  health: IncumbentHealth | null;
  verifiedIdentity: IncumbentIdentity | null;
  shutdownAttempted: boolean;
  shutdownUnauthorized: boolean;
}> {
  const timePort = opts.timePort ?? createRealTimePort();
  const client = createIpcClient(
    opts.socketPath,
    timePort,
    typeof opts.bootToken === 'string' && opts.bootToken.length > 0
      ? { kind: 'boot', token: opts.bootToken }
      : undefined,
  );
  const deadlineMs = timePort.now() + opts.timeoutMs;
  let health: IncumbentHealth | null = null;
  let shutdownAttempted = false;
  let shutdownUnauthorized = false;

  if (remainingBudget(deadlineMs, timePort) > 0) {
    try {
      health = await client.ping<IncumbentHealth | null>({
        timeoutMs: remainingBudget(deadlineMs, timePort),
      });
    } catch {
      // incumbent unresponsive on IPC but socket bound; daemon escalation handles this
    }
  }

  if (health && incumbentOutranksContender(health, opts.desired) && health.status !== 'draining') {
    throw new IncumbentMatchesError(opts.desired);
  }

  if (typeof opts.bootToken === 'string' && opts.bootToken.length > 0 && remainingBudget(deadlineMs, timePort) > 0) {
    shutdownAttempted = true;
    try {
      await client.shutdown<unknown>({ timeoutMs: remainingBudget(deadlineMs, timePort) });
    } catch (error: unknown) {
      if (isShutdownUnauthorizedError(error)) {
        shutdownUnauthorized = true;
      }
      // ignore; incumbent may already be draining or unresponsive
    }
  }

  const verifiedIdentity: IncumbentIdentity | null =
    health && typeof health.pid === 'number' && typeof health.incarnation === 'string'
      ? {
          pid: health.pid,
          incarnation: health.incarnation,
          source: 'health',
          ...(typeof health.instanceId === 'string' && health.instanceId.length > 0
            ? { instanceId: health.instanceId }
            : {}),
        }
      : null;

  return { health, verifiedIdentity, shutdownAttempted, shutdownUnauthorized };
}
