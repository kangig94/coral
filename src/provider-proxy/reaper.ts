import { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import type { ReaperBootstrapCapsule } from './bootstrap-capsule.js';
import {
  createControlEndpoint,
  type ControlEndpoint,
  type ControlEndpointTimer,
  type ControlMethod,
} from './control-endpoint.js';
import {
  createArmedEnforcer,
  type ArmedEnforcer,
  type EnforcementOutcome,
  type EnforcementScheduler,
} from './enforcement.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  canonicalUuidSchema,
  coordinatorIdentitySchema,
  guardianIdentitySchema,
  operationIdentitySchema,
  proxyIdentitySchema,
  reaperIdentitySchema,
} from './protocol.js';
import type { ReaperDeadlineStateMachine } from './orphan-deadline.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '../infra/process-constants.js';

/**
 * The containment the reaper retains. It is recorded once at open and never revised, because the reaper's
 * whole value is holding an identity the group leader cannot invalidate by exiting.
 */
const containmentSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    processStartedAtSeconds: z.number().int().nonnegative(),
    processGroupId: z.number().int().nonnegative(),
    containmentKind: z.string().min(1).max(64),
  })
  .strict();

const registerProviderRootParamsSchema = z
  .object({
    operation: operationIdentitySchema,
    reservationId: canonicalUuidSchema,
    activationNonce: canonicalUuidSchema,
    providerRoot: z
      .object({ pid: z.number().int().nonnegative(), processStartedAtSeconds: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

const operationActivateParamsSchema = registerProviderRootParamsSchema
  .extend({ reaperContainmentReceipt: z.string().min(1) })
  .strict();

const recordedRootSchema = z
  .object({ pid: z.number().int().nonnegative(), processStartedAtSeconds: z.number().int().nonnegative() })
  .strict();

const stopAndReapParamsSchema = z
  .object({
    reaper: reaperIdentitySchema,
    proxy: proxyIdentitySchema,
    providerRoots: z.array(recordedRootSchema).max(MAX_PROXY_OPERATION_LEDGERS),
  })
  .strict();

/** The plan's `reaper.open.v1` request. Validating it is what makes identity disagreement reportable. */
const openParamsSchema = z
  .object({
    bootstrapNonce: z.string().min(1),
    coordinator: coordinatorIdentitySchema,
    guardian: guardianIdentitySchema,
    proxy: proxyIdentitySchema,
    containment: containmentSchema,
  })
  .strict();

/**
 * The caller names the roots it believes are recorded. A disagreement means one side is reasoning about a
 * different containment, which teardown must surface rather than silently reap its own view of.
 */
function assertRecordedSetAgreement(
  claimed: readonly { pid: number; processStartedAtSeconds: number }[],
  recorded: readonly { pid: number; processStartedAtSeconds: number }[],
): void {
  const key = (root: { pid: number; processStartedAtSeconds: number }): string =>
    `${root.pid}@${root.processStartedAtSeconds}`;
  const recordedKeys = new Set(recorded.map(key));
  const claimedKeys = new Set(claimed.map(key));
  if (recordedKeys.size !== claimedKeys.size || [...claimedKeys].some((entry) => !recordedKeys.has(entry))) {
    throw new ProxyControlProtocolError(
      'identity_mismatch',
      'Teardown named a different provider-root set than this reaper recorded.',
    );
  }
}

export type ReaperOptions<Scope extends symbol> = Readonly<{
  capsule: ReaperBootstrapCapsule;
  clock: MonotonicClock<Scope>;
  deadlines: ReaperDeadlineStateMachine<Scope>;
  containment: RecordedContainmentIdentity & { readonly containmentKind: string };
  containmentEnvironment: ProcessContainmentEnvironment<Scope>;
  scheduler: EnforcementScheduler;
  timer: ControlEndpointTimer;
  mintChallenge(): string;
  mintReceipt(): string;
  /** The reaper's own pid/start identity, reported in `ReaperIdentity`. */
  self: Readonly<{ pid: number; processStartedAtSeconds: number }>;
  onOutcome(outcome: EnforcementOutcome): void;
  /** A wake later than the model's bound. Reported, but teardown still proceeds. */
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

export interface Reaper<Scope extends symbol> {
  listen(): Promise<void>;
  close(): Promise<void>;
  enforcer(): ArmedEnforcer<Scope>;
}

/**
 * The reaper is armed before the first operation and stays armed while the guardian is healthy. It accepts
 * a successor rotation only through the guardian's redemption receipt; ordinary traffic never refreshes it.
 */
export function createReaper<Scope extends symbol>(options: ReaperOptions<Scope>): Reaper<Scope> {
  const { capsule, clock, deadlines, containment, scheduler, timer, mintChallenge, mintReceipt, self } = options;
  containmentSchema.parse(containment);

  const enforcer = createArmedEnforcer({
    clock,
    deadlines,
    containment,
    containmentEnvironment: options.containmentEnvironment,
    scheduler,
    onOutcome: options.onOutcome,
    onProgressViolation: options.onProgressViolation,
  });

  const identity = Object.freeze({
    reaperInstanceId: capsule.reaperInstanceId,
    pid: self.pid,
    processStartedAtSeconds: self.processStartedAtSeconds,
    guardianInstanceId: capsule.guardianInstanceId,
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalControlEndpoint: capsule.canonicalControlEndpoint,
    containmentKind: containment.containmentKind,
  });

  const staged = new Map<string, string>();

  // Staging arrives over the guardian pairing channel, not the coordinator's control connection: the
  // guardian must be able to stage a root while the coordinator's own control is still provisional.
  const methods = new Map<string, ControlMethod>([
    [
      'reaper.register-provider-root.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          const request = registerProviderRootParamsSchema.parse(params);
          // Recording precedes execution: a root the reaper never staged is outside the containment it can
          // reach, so staging is what the activation authority is later granted against.
          enforcer.registerProviderRoot(request.operation.operationId, request.providerRoot);
          const receipt = mintReceipt();
          staged.set(request.operation.operationId, receipt);
          return { state: 'staged-contained', reaperContainmentReceipt: receipt };
        },
      },
    ],
    [
      'reaper.operation-activate.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          const request = operationActivateParamsSchema.parse(params);
          const expected = staged.get(request.operation.operationId);
          if (expected === undefined || expected !== request.reaperContainmentReceipt) {
            throw new ProxyControlProtocolError(
              'unauthorized_control',
              'Activation must present this reaper\u2019s staging receipt.',
            );
          }
          return { state: 'activation-authorized', reaperActivationReceipt: mintReceipt() };
        },
      },
    ],
    [
      'reaper.stop-and-reap.v1',
      {
        authority: 'active',
        // Teardown spends the TERM and KILL graces plus a disappearance confirmation, which is longer than
        // a mutation RPC's budget; the caller's own deadline governs instead.
        budgetMs: 'caller-deadline',
        handle: async (params) => {
          const request = stopAndReapParamsSchema.parse(params);
          assertRecordedSetAgreement(request.providerRoots, enforcer.recordedRoots());
          const outcome = await enforcer.stopAndReap(deadlines.bounds().exitDeadline);
          if (outcome.kind !== 'containment-absent') {
            throw new ProxyControlProtocolError('invalid_state', `Reaper teardown did not complete: ${outcome.kind}.`);
          }
          return { state: 'containment-absent', disappearanceReceipt: outcome.disappearanceReceipt };
        },
      },
    ],
  ]);

  const endpoint: ControlEndpoint = createControlEndpoint({
    socketPath: capsule.canonicalControlEndpoint,
    role: {
      openMethod: 'reaper.open.v1',
      heartbeatMethod: 'reaper.heartbeat.v1',
      bootstrapNonce: capsule.bootstrapNonce,
      openResult: (params) => {
        openParamsSchema.parse(params);
        return { reaper: identity };
      },
      methods,
      pairing: { openMethod: 'reaper.pair.v1', secret: capsule.guardianReaperAuthSecret },
    },
    // The deadline machine is the challenge authority: it compares the echo, records the round-trip
    // evidence that moves this enforcer's deadlines, and installs the replacement.
    challenges: deadlines,
    observer: {
      onControlLost: () => deadlines.observeEof(),
      // Pairing loss accelerates an already-armed reaper; it never extends its exit deadline.
      onPairingLost: () => deadlines.observeEof(),
    },
    timer,
    mintChallenge,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    // Teardown may legitimately spend the TERM and KILL graces plus the disappearance confirmation, which
    // is longer than a mutation RPC's budget. Cutting it off would report a failure for a reap in progress.
  });

  return {
    async listen(): Promise<void> {
      await endpoint.listen();
      // Armed before the first operation, so a coordinator that dies during startup is still bounded.
      enforcer.arm();
    },
    async close(): Promise<void> {
      enforcer.disarm();
      await endpoint.close();
    },
    enforcer(): ArmedEnforcer<Scope> {
      return enforcer;
    },
  };
}
