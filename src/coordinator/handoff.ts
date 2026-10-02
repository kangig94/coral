import type { Runtime } from '../runtime/ports.js';
import { compareProductVersions } from '../infra/product-version.js';
import { supervisorExecutableReady } from '../infra/handoff-target.js';
import type { UpgradeIntent } from '../infra/upgrade-intent.js';
import { IpcRpcError, requestIpcMethod } from '../transport/ipc/client.js';
import { SUCCESSION_METHODS } from '../infra/succession-address.js';
import type { LegacyUpgradeStart } from '../infra/legacy-upgrade-contract.js';
import { backendLog } from '../infra/backend-log.js';
import { CoralSetupError, renderHandoffRefusal, type HandoffRefusalInit } from '../runtime/errors.js';
import type { RunStartupRecoveryFn, RunStartupRecoveryOrchestratorFn } from './lifecycle.js';
import type { RunCoordinatorStartupRecoveryFn } from './services/recovery/startup.js';
import {
  IncumbentMatchesError,
  incumbentOutranksContender,
  probeIncumbent,
  type DesiredIncumbentIdentity,
  type IncumbentHealth,
  type IncumbentIdentity,
} from '../transport/ipc/handoff.js';

const SOCKET_BIND_POLL_MS = 200;
const HEALTH_RPC_TIMEOUT_MS = 1_000;
const POST_EXIT_BIND_TIMEOUT_MS = 5_000;

export class HandoffEscalationError extends CoralSetupError {
  constructor(init: HandoffRefusalInit, options?: ErrorOptions) {
    super(renderHandoffRefusal(init), options);
    this.name = 'HandoffEscalationError';
  }
}

export class BackendAlreadyRunningError extends Error {
  constructor() {
    super('Coral backend already running');
    this.name = 'BackendAlreadyRunningError';
  }
}

export class UpgradeSupervisorUnavailableError extends Error {
  constructor(reason: string) {
    super(`Upgrade supervisor unavailable: ${reason}`);
    this.name = 'UpgradeSupervisorUnavailableError';
  }
}

export type HandoffBindResult =
  | { kind: 'bound' }
  | { kind: 'incumbent'; reason: string }
  | { kind: 'addressed-incumbent'; socketPath: string };

export type BoundCoordinator = Readonly<{
  readonly acquiredViaHandoff: boolean;
  readonly runStartupRecovery: RunStartupRecoveryFn;
}>;

type BoundCoordinatorState = {
  runCoordinatorStartupRecovery: RunCoordinatorStartupRecoveryFn | null;
};

const boundCoordinatorStates = new WeakMap<object, BoundCoordinatorState>();

export function registerCoordinatorStartupRecovery(
  bound: BoundCoordinator,
  runCoordinatorStartupRecovery: RunCoordinatorStartupRecoveryFn,
): void {
  const state = boundCoordinatorStates.get(bound);
  if (state === undefined) {
    throw new Error('Bound coordinator capability is not registered');
  }
  if (state.runCoordinatorStartupRecovery !== null) {
    throw new Error('Bound coordinator startup recovery is already registered');
  }
  state.runCoordinatorStartupRecovery = runCoordinatorStartupRecovery;
}

export interface HandoffOptions {
  socketPath: string;
  desired: DesiredIncumbentIdentity;
  bindAttempt: () => Promise<HandoffBindResult>;
  runStartupRecovery: RunStartupRecoveryOrchestratorFn;
  runtime: Pick<Runtime, 'time' | 'env' | 'process'>;
  readVerifiedIncumbentFromDiscovery: (evidence: {
    socketPath: string;
    desired: DesiredIncumbentIdentity;
    lastHealth: IncumbentHealth | null;
  }) => IncumbentIdentity | null;
  requestSuccession?: (socketPath: string, incumbent: IncumbentIdentity, health: IncumbentHealth) => Promise<void>;
  signal?: AbortSignal;
  totalBudgetMs: number;
}

export async function requestUpgradeFromContender(
  options: Readonly<{
    socketPath: string;
    runDir: string;
    incumbent: IncumbentIdentity;
    health: IncumbentHealth;
    target: UpgradeIntent['target'];
    requestId: string;
    time: Runtime['time'];
    request?: (socketPath: string, method: string, params: unknown, options: unknown) => Promise<unknown>;
    supervisorReady?: (pluginRoot: string) => boolean;
    startLegacy: (
      options: Readonly<{
        runDir: string;
        socketPath: string;
        requestId: string;
        incumbent: UpgradeIntent['incumbent'];
        target: UpgradeIntent['target'];
      }>,
    ) => Promise<LegacyUpgradeStart>;
  }>,
): Promise<LegacyUpgradeStart | Readonly<{ kind: 'incumbent-commit-capable' }>> {
  const { health, incumbent, target } = options;
  const instanceId = health.instanceId ?? incumbent.instanceId;
  if (health.version === undefined || instanceId === undefined) {
    return { kind: 'refused', reason: 'verified incumbent identity is incomplete', disposition: 'deferred' };
  }
  try {
    if (health.flavor !== target.build.flavor || compareProductVersions(target.build.version, health.version) <= 0) {
      return { kind: 'refused', reason: 'target does not strictly outrank the incumbent', disposition: 'redundant' };
    }
  } catch {
    return { kind: 'refused', reason: 'build version is invalid', disposition: 'error' };
  }
  if (!(options.supervisorReady ?? supervisorExecutableReady)(target.pluginRootLabel)) {
    return { kind: 'refused', reason: 'supervisor bundle is unavailable', disposition: 'error' };
  }
  if (incumbent.bootToken !== undefined) {
    try {
      const response = await (options.request ?? requestIpcMethod<unknown>)(
        options.socketPath,
        SUCCESSION_METHODS.request,
        { requestId: options.requestId, target },
        { auth: { kind: 'boot', token: incumbent.bootToken }, timeoutMs: 1_000, time: options.time },
      );
      if (
        typeof response === 'object' &&
        response !== null &&
        'kind' in response &&
        response.kind === 'registered' &&
        'incumbentCanCommit' in response &&
        response.incumbentCanCommit === true
      )
        return { kind: 'incumbent-commit-capable' };
    } catch {
      // A failed negotiation cannot prove the incumbent can commit.
    }
  }
  return options.startLegacy({
    runDir: options.runDir,
    socketPath: options.socketPath,
    requestId: options.requestId,
    incumbent: {
      instanceId,
      pid: incumbent.pid,
      incarnation: incumbent.incarnation ?? null,
      version: health.version,
      bundleHash: health.bundleHash,
      flavor: health.flavor,
    },
    target,
  });
}

/** A live, answering incumbent defers a contender only when the contender can read what it must wait on. */
export async function settleContenderUpgrade(
  runDir: string,
  waiting: LegacyUpgradeStart | Readonly<{ kind: 'incumbent-commit-capable' }>,
  recordDeferral: (runDir: string, reason: string) => Promise<void>,
): Promise<void> {
  if (waiting.kind === 'refused' && waiting.disposition === 'error') {
    throw new UpgradeSupervisorUnavailableError(waiting.reason);
  }
  if (waiting.kind === 'refused' && waiting.disposition === 'deferred') {
    backendLog.warn(`Upgrade deferred while the incumbent serves: ${waiting.reason}`);
    await recordDeferral(runDir, waiting.reason);
  }
}

function createBoundCoordinator(sawIncumbent: boolean, opts: HandoffOptions): BoundCoordinator {
  const state: BoundCoordinatorState = { runCoordinatorStartupRecovery: null };
  const bound: BoundCoordinator = Object.freeze({
    acquiredViaHandoff: sawIncumbent,
    runStartupRecovery: (inputs) => {
      if (state.runCoordinatorStartupRecovery === null) {
        throw new Error('Bound coordinator startup recovery is not registered');
      }
      return opts.runStartupRecovery(inputs, state.runCoordinatorStartupRecovery);
    },
  });
  boundCoordinatorStates.set(bound, state);
  return bound;
}

export async function bindWithHandoff(initialOptions: HandoffOptions): Promise<BoundCoordinator> {
  let opts = { ...initialOptions };
  const deadlineMonotonicMs = opts.runtime.time.monotonicNow() + BigInt(opts.totalBudgetMs);
  let sawIncumbent = false;
  let incumbent: IncumbentIdentity | null = null;
  let postExitBindDeadlineMonotonicMs: bigint | null = null;
  let sawDrainingReply = false;
  let sawCapacityRefusal = false;
  let unansweredProbes = 0;
  let lastAnswerAt = opts.runtime.time.monotonicNow();

  while (true) {
    opts.signal?.throwIfAborted();
    if (
      postExitBindDeadlineMonotonicMs === null &&
      incumbent !== null &&
      opts.runtime.process.observeLiveness(incumbent.pid) === 'absent'
    ) {
      incumbent = null;
      postExitBindDeadlineMonotonicMs = opts.runtime.time.monotonicNow() + BigInt(POST_EXIT_BIND_TIMEOUT_MS);
    }
    if (sawIncumbent && opts.runtime.time.monotonicNow() >= (postExitBindDeadlineMonotonicMs ?? deadlineMonotonicMs)) {
      if (sawDrainingReply) {
        throw new HandoffEscalationError({
          code: 'handoff_administrative_drain_timeout',
          context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
        });
      }
      if (sawCapacityRefusal) {
        throw new HandoffEscalationError({
          code: 'handoff_ipc_capacity_timeout',
          context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
        });
      }
      throw new HandoffEscalationError({
        code: 'handoff_socket_holder_unverified',
        context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
      });
    }
    const result = await opts.bindAttempt();
    if (result.kind === 'bound') {
      return createBoundCoordinator(sawIncumbent, opts);
    }
    if (result.kind === 'addressed-incumbent') {
      opts = { ...opts, socketPath: result.socketPath };
    }
    sawIncumbent = true;
    const activeDeadlineMonotonicMs = postExitBindDeadlineMonotonicMs ?? deadlineMonotonicMs;
    const remaining = Number(activeDeadlineMonotonicMs - opts.runtime.time.monotonicNow());
    if (remaining <= 0) {
      if (sawDrainingReply) {
        throw new HandoffEscalationError({
          code: 'handoff_administrative_drain_timeout',
          context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
        });
      }
      if (sawCapacityRefusal) {
        throw new HandoffEscalationError({
          code: 'handoff_ipc_capacity_timeout',
          context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
        });
      }
      throw new HandoffEscalationError({
        code: 'handoff_socket_holder_unverified',
        context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
      });
    }

    let health: IncumbentHealth | null;
    let capacityRefused = false;
    try {
      health = await probeIncumbent({
        socketPath: opts.socketPath,
        timeoutMs: Math.min(HEALTH_RPC_TIMEOUT_MS, remaining),
        timePort: opts.runtime.time,
      });
    } catch (error: unknown) {
      if (!(error instanceof IpcRpcError && error.code === 'too_many_ipc_connections')) throw error;
      capacityRefused = true;
      sawCapacityRefusal = true;
      sawDrainingReply = false;
      unansweredProbes = 0;
      lastAnswerAt = opts.runtime.time.monotonicNow();
      health = null;
    }
    incumbent =
      opts.readVerifiedIncumbentFromDiscovery({
        socketPath: opts.socketPath,
        desired: opts.desired,
        lastHealth: health,
      }) ?? incumbent;
    if (health?.status === 'draining') {
      sawDrainingReply = true;
      sawCapacityRefusal = false;
      unansweredProbes = 0;
      lastAnswerAt = opts.runtime.time.monotonicNow();
    } else if (health === null && !capacityRefused) {
      unansweredProbes += 1;
      if (unansweredProbes >= 2 && opts.runtime.time.monotonicNow() - lastAnswerAt >= BigInt(SOCKET_BIND_POLL_MS * 2)) {
        sawDrainingReply = false;
        sawCapacityRefusal = false;
      }
    }
    if (health !== null && health.status !== 'draining') {
      if (
        health.version !== undefined &&
        health.flavor === opts.desired.flavor &&
        !incumbentOutranksContender(health, opts.desired)
      ) {
        const incumbent = opts.readVerifiedIncumbentFromDiscovery({
          socketPath: opts.socketPath,
          desired: opts.desired,
          lastHealth: health,
        });
        if (incumbent === null && health.status === 'starting') {
          const pollMs = Math.min(
            SOCKET_BIND_POLL_MS,
            Number(activeDeadlineMonotonicMs - opts.runtime.time.monotonicNow()),
          );
          if (pollMs > 0)
            await opts.runtime.time.sleep(pollMs, opts.signal === undefined ? undefined : { signal: opts.signal });
          continue;
        }
        if (incumbent !== null) {
          try {
            await opts.requestSuccession?.(opts.socketPath, incumbent, health);
          } catch (error: unknown) {
            if (error instanceof UpgradeSupervisorUnavailableError) throw error;
            // Failed negotiation never grants a contender replacement authority.
          }
        }
      }
      throw new IncumbentMatchesError(opts.desired);
    }

    // An unanswered probe of a live holder is not a refusal: a stalled incumbent answers the next one, and only
    // the deadline may turn continued silence into `handoff_socket_holder_unverified`.
    const pollMs = Math.min(SOCKET_BIND_POLL_MS, Number(activeDeadlineMonotonicMs - opts.runtime.time.monotonicNow()));
    if (pollMs > 0) {
      await opts.runtime.time.sleep(pollMs, opts.signal === undefined ? undefined : { signal: opts.signal });
    }
  }
}
