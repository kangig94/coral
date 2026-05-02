// Coordinator-side bind/escalation state machine. Sits above transport's
// `requestIncumbentShutdown`: speaks IPC for graceful handoff, polls
// bindability, and only signals (SIGTERM → SIGKILL) after revalidating the
// incumbent's pid+processStartedAt against the kernel.
//
// All time/process/env access flows through `runtime` ports per the Single
// Runtime World rule.

import { probeProcessStartedAtSeconds } from '../infra/node-process.js';
import { backendLog } from '../infra/backend-log.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { Runtime } from '../runtime/ports.js';
import {
  requestIncumbentShutdown,
  type DesiredIncumbentIdentity,
  type IncumbentHealth,
  type IncumbentIdentity,
} from '../transport/ipc/handoff.js';

const SOCKET_BIND_POLL_MS = 200;
const SHUTDOWN_RPC_TIMEOUT_MS = 1_000;

/**
 * Raised when the contender exhausts the bounded escalation window without
 * acquiring the socket — typically because no verified pid was available, or
 * a revalidation step refused to signal an unverified target. Distinguished
 * from `IncumbentMatchesError` (we are redundant) and from per-step IPC
 * errors (transient).
 */
export class HandoffEscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffEscalationError';
  }
}

/**
 * Raised when the contender discovers the incumbent already serves the same
 * bundle/flavor/namespace and is therefore not a candidate for replacement.
 * Bootstrap translates this into an info-log + `exit 0` (the contender is
 * redundant; the existing daemon stays).
 */
export class BackendAlreadyRunningError extends Error {
  constructor() {
    super('Coral backend already running');
    this.name = 'BackendAlreadyRunningError';
  }
}

export type HandoffBindResult = { kind: 'bound' } | { kind: 'incumbent'; reason: string };

export interface HandoffOptions {
  socketPath: string;
  desired: DesiredIncumbentIdentity;
  bindAttempt: () => Promise<HandoffBindResult>;
  runtime: Pick<Runtime, 'time' | 'process' | 'env'>;
  /**
   * Read `coordinator.json` and cross-check it against the bound socket and
   * the most recent IPC health evidence. Returns null if the discovery
   * record is missing, doesn't match `socketPath`/flavor/namespace, or
   * contradicts the health snapshot we obtained from the same socket.
   */
  readVerifiedIncumbentFromDiscovery: (evidence: {
    socketPath: string;
    desired: DesiredIncumbentIdentity;
    lastHealth: IncumbentHealth | null;
  }) => IncumbentIdentity | null;
  totalBudgetMs: number;
}

type SignalVerificationResult = 'matched' | 'gone';

function verifySignalTarget(
  incumbent: IncumbentIdentity,
  process: Pick<Runtime['process'], 'isAlive'>,
  platform: NodeJS.Platform,
): SignalVerificationResult {
  // Canonical pattern: src/infra/backend-discovery.ts:127,162.
  const liveStartedAt = probeProcessStartedAtSeconds(incumbent.pid, platform);
  if (liveStartedAt === incumbent.processStartedAt) {
    return 'matched';
  }
  if (liveStartedAt === null && !process.isAlive(incumbent.pid)) {
    return 'gone';
  }
  const reason =
    liveStartedAt === null ? 'process start time unavailable while pid is alive' : 'process start time mismatch';
  throw new HandoffEscalationError(`Refusing to signal unverified incumbent pid=${incumbent.pid}: ${reason}`);
}

/**
 * Repeatedly attempt socket bind. On 'incumbent' result:
 *   1. open IPC client to incumbent's socket
 *   2. requestIncumbentShutdown() → health + transport.shutdown; if
 *      bundle/flavor/namespace match and the incumbent is not draining,
 *      throw IncumbentMatchesError (we're redundant)
 *   3. poll bind until budget expires
 *   4. on budget expiry, escalate via process signals only after revalidating
 *      pid+processStartedAt
 */
export async function bindWithHandoff(opts: HandoffOptions): Promise<{ acquiredViaHandoff: boolean }> {
  const deadline = opts.runtime.time.now() + opts.totalBudgetMs;
  const platform = opts.runtime.env.platform() as NodeJS.Platform;
  let sawIncumbent = false;
  let incumbent: IncumbentIdentity | null = null;
  let lastHealth: IncumbentHealth | null = null;
  let sigtermAt: number | null = null;
  let sigkillAt: number | null = null;

  while (true) {
    const result = await opts.bindAttempt();
    if (result.kind === 'bound') {
      return { acquiredViaHandoff: sawIncumbent };
    }

    sawIncumbent = true;
    let remaining = deadline - opts.runtime.time.now();
    if (remaining > 0) {
      const shutdownResult = await requestIncumbentShutdown({
        socketPath: opts.socketPath,
        desired: opts.desired,
        timeoutMs: Math.min(SHUTDOWN_RPC_TIMEOUT_MS, remaining),
        timePort: opts.runtime.time,
      });
      lastHealth = shutdownResult.health ?? lastHealth;
      if (shutdownResult.verifiedIdentity && incumbent === null) {
        incumbent = shutdownResult.verifiedIdentity;
        const incumbentBundleHash = shutdownResult.health?.bundleHash ?? 'unknown';
        backendLog.info(`Incumbent bundleHash=${incumbentBundleHash} pid=${incumbent.pid}; requested shutdown via IPC`);
      }
    }
    if (incumbent === null) {
      incumbent = opts.readVerifiedIncumbentFromDiscovery({
        socketPath: opts.socketPath,
        desired: opts.desired,
        lastHealth,
      });
    }

    remaining = deadline - opts.runtime.time.now();
    if (remaining <= 0) {
      if (incumbent === null) {
        throw new HandoffEscalationError('Incumbent socket remained bound, but no verified pid was available');
      }
      if (sigtermAt === null) {
        if (verifySignalTarget(incumbent, opts.runtime.process, platform) === 'gone') {
          backendLog.info(`Incumbent pid=${incumbent.pid} exited before SIGTERM; retrying bind`);
          incumbent = null;
          sigtermAt = null;
          sigkillAt = null;
          await opts.runtime.time.sleep(SOCKET_BIND_POLL_MS);
          continue;
        }
        try {
          opts.runtime.process.kill(incumbent.pid, 'SIGTERM');
        } catch {
          // best-effort; if signal fails the incumbent may already be gone
        }
        sigtermAt = opts.runtime.time.now();
        backendLog.warn(`Incumbent did not exit within ${opts.totalBudgetMs}ms; sent SIGTERM to pid=${incumbent.pid}`);
      } else if (sigkillAt === null && opts.runtime.time.now() - sigtermAt >= SIGTERM_GRACE_MS) {
        if (verifySignalTarget(incumbent, opts.runtime.process, platform) === 'gone') {
          backendLog.info(`Incumbent pid=${incumbent.pid} exited before SIGKILL; retrying bind`);
          incumbent = null;
          sigtermAt = null;
          sigkillAt = null;
          await opts.runtime.time.sleep(SOCKET_BIND_POLL_MS);
          continue;
        }
        try {
          opts.runtime.process.kill(incumbent.pid, 'SIGKILL');
        } catch {
          // best-effort
        }
        sigkillAt = opts.runtime.time.now();
        backendLog.error(`Incumbent did not exit after SIGTERM grace; sent SIGKILL to pid=${incumbent.pid}`);
      } else if (sigkillAt !== null && opts.runtime.time.now() - sigkillAt >= SIGKILL_GRACE_MS) {
        throw new HandoffEscalationError(
          `Incumbent socket remained bound after SIGKILL grace for pid=${incumbent.pid}`,
        );
      }
      await opts.runtime.time.sleep(SOCKET_BIND_POLL_MS);
      continue;
    }

    await opts.runtime.time.sleep(Math.min(SOCKET_BIND_POLL_MS, remaining));
  }
}
