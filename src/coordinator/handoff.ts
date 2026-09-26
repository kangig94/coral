import type { Runtime } from '../runtime/ports.js';
import { compareProductVersions } from '../infra/product-version.js';
import { readUpgradeIntent, type UpgradeIntent } from '../infra/upgrade-intent.js';
import { requestIpcMethod } from '../transport/ipc/client.js';
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

export class UpgradeWaiterUnavailableError extends Error {
  constructor(reason: string) {
    super(`Upgrade waiter unavailable: ${reason}`);
    this.name = 'UpgradeWaiterUnavailableError';
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
  runtime: Pick<Runtime, 'time' | 'env'>;
  readVerifiedIncumbentFromDiscovery: (evidence: {
    socketPath: string;
    desired: DesiredIncumbentIdentity;
    lastHealth: IncumbentHealth | null;
  }) => IncumbentIdentity | null;
  requestSuccession?: (socketPath: string, incumbent: IncumbentIdentity, health: IncumbentHealth) => Promise<void>;
  signal?: AbortSignal;
  totalBudgetMs: number;
}

/** An absent or failed capability response cannot authorize the contender to skip its waiter. */
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
    startLegacy: (
      options: Readonly<{
        runDir: string;
        socketPath: string;
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
  const observed = readUpgradeIntent(options.runDir);
  const recordedIncumbent =
    observed.kind === 'readable' &&
    observed.intent.incumbent.instanceId === instanceId &&
    observed.intent.incumbent.pid === incumbent.pid &&
    observed.intent.incumbent.version === health.version &&
    observed.intent.incumbent.bundleHash === health.bundleHash &&
    observed.intent.incumbent.flavor === health.flavor
      ? observed.intent.incumbent
      : null;
  return options.startLegacy({
    runDir: options.runDir,
    socketPath: options.socketPath,
    incumbent: recordedIncumbent ?? {
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

/**
 * Against a live, answering incumbent a contender exits as a redundant one does, unless it cannot read what it would
 * wait on. A deferral is recorded where status reads it, and names its exit there.
 */
export async function settleContenderUpgrade(
  runDir: string,
  waiting: LegacyUpgradeStart | Readonly<{ kind: 'incumbent-commit-capable' }>,
  recordDeferral: (runDir: string, reason: string) => Promise<void>,
): Promise<void> {
  if (waiting.kind === 'refused' && waiting.disposition === 'error') {
    throw new UpgradeWaiterUnavailableError(waiting.reason);
  }
  if (waiting.kind === 'deferred' || (waiting.kind === 'refused' && waiting.disposition === 'deferred')) {
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

  while (true) {
    opts.signal?.throwIfAborted();
    if (sawIncumbent && opts.runtime.time.monotonicNow() >= deadlineMonotonicMs) {
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

    const remaining = Number(deadlineMonotonicMs - opts.runtime.time.monotonicNow());
    if (remaining <= 0) {
      throw new HandoffEscalationError({
        code: 'handoff_socket_holder_unverified',
        context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
      });
    }

    const health = await probeIncumbent({
      socketPath: opts.socketPath,
      timeoutMs: Math.min(HEALTH_RPC_TIMEOUT_MS, remaining),
      timePort: opts.runtime.time,
    });
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
        if (incumbent !== null) {
          try {
            await opts.requestSuccession?.(opts.socketPath, incumbent, health);
          } catch (error: unknown) {
            if (error instanceof UpgradeWaiterUnavailableError) throw error;
            // Failed negotiation never grants a contender replacement authority.
          }
        }
      }
      throw new IncumbentMatchesError(opts.desired);
    }

    // An unanswered probe of a live holder is not a refusal: a stalled incumbent answers the next one, and only
    // the deadline may turn continued silence into `handoff_socket_holder_unverified`.
    const pollMs = Math.min(SOCKET_BIND_POLL_MS, Number(deadlineMonotonicMs - opts.runtime.time.monotonicNow()));
    if (pollMs > 0) {
      await opts.runtime.time.sleep(pollMs, opts.signal === undefined ? undefined : { signal: opts.signal });
    }
  }
}
