import type { Runtime } from '../runtime/ports.js';
import { CoralSetupError, renderHandoffRefusal, type HandoffRefusalInit } from '../runtime/errors.js';
import type { RunStartupRecoveryFn, RunStartupRecoveryOrchestratorFn } from './lifecycle.js';
import type { RunCoordinatorStartupRecoveryFn } from './services/recovery/startup.js';
import {
  IncumbentMatchesError,
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
  runtime: Pick<Runtime, 'time' | 'process' | 'env'>;
  readVerifiedIncumbentFromDiscovery: (evidence: {
    socketPath: string;
    desired: DesiredIncumbentIdentity;
    lastHealth: IncumbentHealth | null;
  }) => IncumbentIdentity | null;
  signal?: AbortSignal;
  totalBudgetMs: number;
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
      throw new IncumbentMatchesError(opts.desired);
    }

    if (health === null) {
      const identity = opts.readVerifiedIncumbentFromDiscovery({
        socketPath: opts.socketPath,
        desired: opts.desired,
        lastHealth: null,
      });
      if (identity !== null && opts.runtime.process.observeLiveness(identity.pid) === 'alive') {
        throw new HandoffEscalationError({
          code: 'handoff_socket_holder_unverified',
          context: { stage: 'handoff-deadline', socketPath: opts.socketPath },
        });
      }
    }

    const pollMs = Math.min(SOCKET_BIND_POLL_MS, Number(deadlineMonotonicMs - opts.runtime.time.monotonicNow()));
    if (pollMs > 0) {
      await opts.runtime.time.sleep(pollMs, opts.signal === undefined ? undefined : { signal: opts.signal });
    }
  }
}
