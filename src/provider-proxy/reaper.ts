import { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import { createBootstrapNonceCredential, type ReaperBootstrapCapsule } from './bootstrap-capsule.js';
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
import type { EnforcerDeadlineStateMachine } from './orphan-deadline.js';
import { MAX_PROXY_OPERATION_LEDGERS } from './ledger.js';

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
  deadlines: EnforcerDeadlineStateMachine<Scope>;
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
  /** Null until the guardian has recorded the containment this reaper is to enforce. */
  enforcer(): ArmedEnforcer<Scope> | null;
}

/**
 * The reaper is armed as soon as it knows what to enforce, and stays armed while the guardian is healthy. It
 * accepts a successor rotation only through the guardian's redemption receipt; ordinary traffic never
 * refreshes it.
 *
 * Containment arrives from the guardian over the pairing channel rather than in the capsule or at
 * `reaper.open.v1`, because of when each party knows it. The guardian spawns the reaper *before* the proxy —
 * so no capsule written at spawn time can name a process group that does not exist yet — and the coordinator
 * only learns the group from the guardian's readiness, so having it supply the value at open would let the
 * reaper be told to enforce a containment nobody verified. The guardian is the one party that observes the
 * group being created, so it is the one party that may name it.
 */
export function createReaper<Scope extends symbol>(options: ReaperOptions<Scope>): Reaper<Scope> {
  const { capsule, clock, deadlines, scheduler, timer, mintChallenge, mintReceipt, self } = options;
  let recorded: (RecordedContainmentIdentity & { readonly containmentKind: string }) | null = null;
  let enforcer: ArmedEnforcer<Scope> | null = null;

  const requireEnforcer = (): ArmedEnforcer<Scope> => {
    if (enforcer === null) {
      throw new ProxyControlProtocolError('invalid_state', 'This reaper has not been given a containment to hold.');
    }
    return enforcer;
  };

  const identityOf = (
    containment: RecordedContainmentIdentity & { readonly containmentKind: string },
  ): Record<string, unknown> =>
    Object.freeze({
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

  const bootstrapNonce = createBootstrapNonceCredential(capsule.bootstrapNonce);
  const staged = new Map<string, string>();

  // Staging arrives over the guardian pairing channel, not the coordinator's control connection: the
  // guardian must be able to stage a root while the coordinator's own control is still provisional.
  const methods = new Map<string, ControlMethod>([
    [
      'reaper.open.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = openParamsSchema.parse(params);
          bootstrapNonce.spend(request.bootstrapNonce);
          if (recorded === null) {
            throw new ProxyControlProtocolError('invalid_state', 'This reaper holds no containment yet.');
          }
          // The coordinator's `containment` is an agreement check, not the source: it learned the group from
          // the guardian's readiness, and a disagreement means the two are reasoning about different sets.
          if (
            request.containment.pid !== recorded.pid ||
            request.containment.processStartedAtSeconds !== recorded.processStartedAtSeconds ||
            request.containment.processGroupId !== recorded.processGroupId ||
            request.containment.containmentKind !== recorded.containmentKind
          ) {
            throw new ProxyControlProtocolError(
              'identity_mismatch',
              'The coordinator named a different containment than the guardian recorded.',
            );
          }
          return { reaper: identityOf(recorded) };
        },
      },
    ],
    [
      'reaper.record-containment.v1',
      {
        // The guardian's channel, because the guardian is the party that watched the group come into being.
        authority: 'pairing',
        handle: (params) => {
          const request = containmentSchema.parse(params);
          if (recorded !== null) {
            // Idempotent for the identical containment, a mismatch otherwise: revising it would silently
            // move what this reaper is holding, and only one group was ever created for this set.
            if (
              recorded.pid !== request.pid ||
              recorded.processStartedAtSeconds !== request.processStartedAtSeconds ||
              recorded.processGroupId !== request.processGroupId ||
              recorded.containmentKind !== request.containmentKind
            ) {
              throw new ProxyControlProtocolError('identity_mismatch', 'This reaper already holds a containment.');
            }
            return { state: 'containment-recorded', reaper: identityOf(recorded) };
          }
          recorded = request;
          enforcer = createArmedEnforcer({
            clock,
            deadlines,
            containment: request,
            containmentEnvironment: options.containmentEnvironment,
            scheduler,
            onOutcome: options.onOutcome,
            onProgressViolation: options.onProgressViolation,
          });
          // Armed the moment it knows what to enforce, so a coordinator that dies immediately afterwards is
          // already bounded by this reaper's own deadline.
          enforcer.arm();
          return { state: 'containment-recorded', reaper: identityOf(request) };
        },
      },
    ],
    [
      'reaper.register-provider-root.v1',
      {
        authority: 'pairing',
        handle: (params) => {
          const request = registerProviderRootParamsSchema.parse(params);
          // Recording precedes execution: a root the reaper never staged is outside the containment it can
          // reach, so staging is what the activation authority is later granted against.
          requireEnforcer().registerProviderRoot(request.providerRoot);
          const receipt = mintReceipt();
          if (staged.size >= MAX_PROXY_OPERATION_LEDGERS) {
            throw new ProxyControlProtocolError('invalid_state', 'This reaper holds its maximum staged operations.');
          }
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
          // The receipt is spent by the activation it authorizes; nothing reads it afterwards, and the
          // reaper has no release RPC, so retaining it would grow this map for the life of the set.
          staged.delete(request.operation.operationId);
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
          const armed = requireEnforcer();
          assertRecordedSetAgreement(request.providerRoots, armed.recordedRoots());
          const outcome = await armed.stopAndReap(deadlines.bounds().exitDeadline);
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
      heartbeatMethod: 'reaper.heartbeat.v1',
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
      // Arming waits for `reaper.record-containment.v1`: before it, there is no identity to enforce, and an
      // enforcer without one could only ever confirm the absence of nothing.
      await endpoint.listen();
    },
    async close(): Promise<void> {
      enforcer?.disarm();
      await endpoint.close();
    },
    enforcer(): ArmedEnforcer<Scope> | null {
      return enforcer;
    },
  };
}
