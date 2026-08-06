import { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import type { ReaperBootstrapCapsule } from './bootstrap-capsule.js';
import {
  createControlEndpoint,
  type ControlEndpoint,
  type ControlEndpointTimer,
  type ControlMethodHandler,
} from './control-endpoint.js';
import {
  createArmedEnforcer,
  type ArmedEnforcer,
  type EnforcementOutcome,
  type EnforcementScheduler,
} from './enforcement.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, canonicalUuidSchema, proxyIdentitySchema } from './protocol.js';
import type { ReaperDeadlineStateMachine } from './orphan-deadline.js';

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
    operation: z.object({ operationId: canonicalUuidSchema }).passthrough(),
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

const stopAndReapParamsSchema = z
  .object({
    proxy: proxyIdentitySchema,
    providerRoots: z
      .array(
        z
          .object({ pid: z.number().int().nonnegative(), processStartedAtSeconds: z.number().int().nonnegative() })
          .strict(),
      )
      .max(128),
  })
  .strict();

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
  const pairedMethods = new Map<string, ControlMethodHandler>([
    [
      'reaper.register-provider-root.v1',
      (params) => {
        const request = registerProviderRootParamsSchema.parse(params);
        // Recording precedes execution: a root the reaper never staged is outside the containment it can
        // reach, so staging is what the activation authority is later granted against.
        enforcer.registerProviderRoot(request.operation.operationId, request.providerRoot);
        const receipt = mintReceipt();
        staged.set(request.operation.operationId, receipt);
        return { state: 'staged-contained', reaperContainmentReceipt: receipt };
      },
    ],
    [
      'reaper.operation-activate.v1',
      (params) => {
        const request = operationActivateParamsSchema.parse(params);
        const expected = staged.get(request.operation.operationId);
        if (expected === undefined || expected !== request.reaperContainmentReceipt) {
          throw new Error('reaper_activation_unstaged: activation must present this reaper’s staging receipt.');
        }
        return { state: 'activation-authorized', reaperActivationReceipt: mintReceipt() };
      },
    ],
  ]);

  const methods = new Map<string, ControlMethodHandler>([
    [
      'reaper.stop-and-reap.v1',
      async (params) => {
        stopAndReapParamsSchema.parse(params);
        const outcome = await enforcer.stopAndReap(deadlines.bounds().exitDeadline);
        if (outcome.kind !== 'containment-absent') {
          throw new Error(`reaper_stop_and_reap_failed: ${outcome.kind}`);
        }
        return { state: 'containment-absent', disappearanceReceipt: outcome.disappearanceReceipt };
      },
    ],
  ]);

  const endpoint: ControlEndpoint = createControlEndpoint({
    socketPath: capsule.canonicalControlEndpoint,
    role: {
      openMethod: 'reaper.open.v1',
      heartbeatMethod: 'reaper.heartbeat.v1',
      bootstrapNonce: capsule.bootstrapNonce,
      openResult: () => ({ reaper: identity }),
      methods,
      pairing: {
        openMethod: 'reaper.pair.v1',
        secret: capsule.guardianReaperAuthSecret,
        methods: pairedMethods,
      },
    },
    observer: {
      onChallengeEcho: () => {
        // Evidence is recorded by the deadline machine, which owns what a round trip is worth.
      },
      onControlLost: () => deadlines.observeEof(),
      // Pairing loss accelerates an already-armed reaper; it never extends its exit deadline.
      onPairingLost: () => deadlines.observeEof(),
    },
    timer,
    mintChallenge,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
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
