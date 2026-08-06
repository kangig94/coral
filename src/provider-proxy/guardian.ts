import { z } from 'zod';

import type { MonotonicClock } from '../infra/monotonic-clock.js';
import type { ProcessContainmentEnvironment, RecordedContainmentIdentity } from '../infra/process-containment.js';
import type { GuardianBootstrapCapsule } from './bootstrap-capsule.js';
import type { ControlClient } from './control-client.js';
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
import type { GuardianDeadlineStateMachine } from './orphan-deadline.js';

const providerRootSchema = z
  .object({ pid: z.number().int().nonnegative(), processStartedAtSeconds: z.number().int().nonnegative() })
  .strict();

const registerProviderRootParamsSchema = z
  .object({
    proxy: proxyIdentitySchema,
    operation: z.object({ operationId: canonicalUuidSchema }).passthrough(),
    reservationId: canonicalUuidSchema,
    activationNonce: canonicalUuidSchema,
    providerPid: z.number().int().nonnegative(),
    providerProcessStartedAtSeconds: z.number().int().nonnegative(),
  })
  .strict();

const operationActivateParamsSchema = z
  .object({
    operation: z.object({ operationId: canonicalUuidSchema }).passthrough(),
    reservationId: canonicalUuidSchema,
    activationNonce: canonicalUuidSchema,
    providerRoot: providerRootSchema,
    jointContainmentReceipt: z.string().min(1),
  })
  .strict();

const operationReleaseParamsSchema = z
  .object({
    operation: z.object({ operationId: canonicalUuidSchema }).passthrough(),
    reservationId: canonicalUuidSchema,
    activationNonce: canonicalUuidSchema,
    jointContainmentReceipt: z.string().min(1),
  })
  .strict();

/** Both authorities must ACK the same identity before a root may execute, so the receipt names both. */
type StagedMembership = Readonly<{
  jointContainmentReceipt: string;
  reaperContainmentReceipt: string;
  root: z.infer<typeof providerRootSchema>;
}>;

export type GuardianOptions<Scope extends symbol> = Readonly<{
  capsule: GuardianBootstrapCapsule;
  clock: MonotonicClock<Scope>;
  deadlines: GuardianDeadlineStateMachine<Scope>;
  containment: RecordedContainmentIdentity;
  containmentEnvironment: ProcessContainmentEnvironment<Scope>;
  scheduler: EnforcementScheduler;
  timer: ControlEndpointTimer;
  mintChallenge(): string;
  mintReceipt(): string;
  /** The paired reaper channel, held open for the lifetime of the set. */
  reaperChannel: ControlClient;
  self: Readonly<{ pid: number; processStartedAtSeconds: number }>;
  onOutcome(outcome: EnforcementOutcome): void;
  /** A wake later than the model's bound. Reported, but teardown still proceeds. */
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

export interface Guardian<Scope extends symbol> {
  listen(): Promise<void>;
  close(): Promise<void>;
  enforcer(): ArmedEnforcer<Scope>;
}

/**
 * The guardian owns grant-redemption admission and adoption state. It mirrors the reaper's recorded set so
 * it can enforce the same disappearance condition, but it can neither move nor extend the reaper's deadline.
 */
export function createGuardian<Scope extends symbol>(options: GuardianOptions<Scope>): Guardian<Scope> {
  const { capsule, clock, deadlines, containment, scheduler, timer, mintChallenge, mintReceipt, self } = options;

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
    guardianInstanceId: capsule.guardianInstanceId,
    pid: self.pid,
    processStartedAtSeconds: self.processStartedAtSeconds,
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalControlEndpoint: capsule.canonicalControlEndpoint,
  });

  const staged = new Map<string, StagedMembership>();

  const methods = new Map<string, ControlMethodHandler>([
    [
      'guardian.register-provider-root.v1',
      async (params) => {
        const request = registerProviderRootParamsSchema.parse(params);
        const root = { pid: request.providerPid, processStartedAtSeconds: request.providerProcessStartedAtSeconds };
        // Forward the exact root; a receipt is only issued once both authorities ACK the same identity, so
        // neither can be talked into containing something the other never recorded.
        const reaperResult = (await options.reaperChannel.call(
          'reaper.register-provider-root.v1',
          {
            operation: request.operation,
            reservationId: request.reservationId,
            activationNonce: request.activationNonce,
            providerRoot: root,
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        )) as { state?: string; reaperContainmentReceipt?: string };
        if (reaperResult.state !== 'staged-contained' || typeof reaperResult.reaperContainmentReceipt !== 'string') {
          throw new Error('guardian_staging_unconfirmed: the reaper did not stage the reported provider root.');
        }
        enforcer.registerProviderRoot(request.operation.operationId, root);
        const jointContainmentReceipt = mintReceipt();
        staged.set(request.operation.operationId, {
          jointContainmentReceipt,
          reaperContainmentReceipt: reaperResult.reaperContainmentReceipt,
          root,
        });
        return { state: 'staged-contained', providerRoot: root, jointContainmentReceipt };
      },
    ],
    [
      'guardian.operation-activate.v1',
      async (params) => {
        const request = operationActivateParamsSchema.parse(params);
        const membership = staged.get(request.operation.operationId);
        if (membership === undefined || membership.jointContainmentReceipt !== request.jointContainmentReceipt) {
          throw new Error('guardian_activation_unstaged: activation must present the joint containment receipt.');
        }
        if (
          membership.root.pid !== request.providerRoot.pid ||
          membership.root.processStartedAtSeconds !== request.providerRoot.processStartedAtSeconds
        ) {
          throw new Error('guardian_activation_identity_mismatch: activation named a different provider root.');
        }
        // Activation authority is converted only after the reaper confirms the same target is registered.
        const reaperResult = (await options.reaperChannel.call(
          'reaper.operation-activate.v1',
          {
            operation: request.operation,
            reservationId: request.reservationId,
            activationNonce: request.activationNonce,
            providerRoot: request.providerRoot,
            reaperContainmentReceipt: membership.reaperContainmentReceipt,
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        )) as { state?: string };
        if (reaperResult.state !== 'activation-authorized') {
          throw new Error('guardian_activation_unconfirmed: the reaper did not authorize activation.');
        }
        return { state: 'activation-authorized', jointActivationReceipt: mintReceipt() };
      },
    ],
    [
      'guardian.operation-release.v1',
      (params) => {
        const request = operationReleaseParamsSchema.parse(params);
        const membership = staged.get(request.operation.operationId);
        if (membership === undefined || membership.jointContainmentReceipt !== request.jointContainmentReceipt) {
          throw new Error('guardian_release_unstaged: release must present the joint containment receipt.');
        }
        // The membership record is dropped, but the recorded root stays in the enforcer: a released
        // operation does not prove its process is gone, and only teardown may conclude absence.
        staged.delete(request.operation.operationId);
        return { state: 'membership-released' };
      },
    ],
    [
      'guardian.stop-and-reap.v1',
      async () => {
        const outcome = await enforcer.stopAndReap(deadlines.bounds().exitDeadline);
        if (outcome.kind !== 'containment-absent') {
          throw new Error(`guardian_stop_and_reap_failed: ${outcome.kind}`);
        }
        return { state: 'containment-absent', disappearanceReceipt: outcome.disappearanceReceipt };
      },
    ],
  ]);

  const endpoint: ControlEndpoint = createControlEndpoint({
    socketPath: capsule.canonicalControlEndpoint,
    role: {
      openMethod: 'guardian.open.v1',
      heartbeatMethod: 'guardian.heartbeat.v1',
      bootstrapNonce: capsule.bootstrapNonce,
      openResult: () => ({ guardian: identity }),
      methods,
    },
    challenges: deadlines,
    observer: {
      onControlLost: () => deadlines.observeEof(),
    },
    timer,
    mintChallenge,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    // Teardown may legitimately spend the TERM and KILL graces plus the disappearance confirmation, which
    // is longer than a mutation RPC's budget. Cutting it off would report a failure for a reap in progress.
    unbudgetedMethods: new Set([`${'}${role}${'}.stop-and-reap.v1`]),
  });

  return {
    async listen(): Promise<void> {
      await endpoint.listen();
      enforcer.arm();
    },
    async close(): Promise<void> {
      enforcer.disarm();
      options.reaperChannel.close();
      await endpoint.close();
    },
    enforcer(): ArmedEnforcer<Scope> {
      return enforcer;
    },
  };
}
