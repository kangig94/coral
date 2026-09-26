import { z } from 'zod';

import { sameControlTenancyHolder, type ControlTenancyHolder } from './control-endpoint.js';
import {
  ProxyControlProtocolError,
  canonicalUuidSchema,
  flavorSchema,
  generationSchema,
  type CoordinatorIdentity,
} from './protocol.js';

/**
 * The controller-succession generation this build's guardian, reaper, and proxy accept, and the one its
 * coordinator drives. It is also the contract generation of the `provider-proxy-sets` succession owner, so a
 * successor build declares it in its capability file to say it can take these hosts over.
 */
export const PROVIDER_PROXY_CONTROL_GENERATION = 1;

/**
 * The part of a coordinator identity that names the build it runs. A host keeps its own build as immutable
 * provenance; a controller build is the separate, mutable fact of which build's coordinators currently hold
 * the set and may redeem its recovery grant.
 */
export const controllerBuildSchema = z
  .object({ generation: generationSchema, flavor: flavorSchema, buildSetId: canonicalUuidSchema })
  .strict();

export type ControllerBuild = z.infer<typeof controllerBuildSchema>;

export function controllerBuildOf(
  identity: Pick<CoordinatorIdentity, 'generation' | 'flavor' | 'buildSetId'>,
): ControllerBuild {
  return Object.freeze({ generation: identity.generation, flavor: identity.flavor, buildSetId: identity.buildSetId });
}

export function sameControllerBuild(left: ControllerBuild, right: ControllerBuild): boolean {
  return left.generation === right.generation && left.flavor === right.flavor && left.buildSetId === right.buildSetId;
}

/**
 * `guardian.controller-transfer.v1` and `controller-transfer.v1`'s shared request: the current controller
 * authorizes one successor build to redeem the recovery grant the host already holds. Naming that grant is how
 * the host proves it recorded the attempt's recovery grant before it accepted the transfer.
 */
export const controllerTransferParamsSchema = z
  .object({
    grantId: canonicalUuidSchema,
    attemptId: z.string().min(1).max(128),
    successor: controllerBuildSchema,
    controlGeneration: z.number().int().positive(),
  })
  .strict();

export type ControllerTransferParams = z.infer<typeof controllerTransferParamsSchema>;

export const controllerTransferResultSchema = z
  .object({
    state: z.literal('transfer-authorized'),
    grantId: canonicalUuidSchema,
    attemptId: z.string().min(1).max(128),
  })
  .strict();

export function assertCompatibleControlGeneration(controlGeneration: number): void {
  if (controlGeneration !== PROVIDER_PROXY_CONTROL_GENERATION) {
    throw new ProxyControlProtocolError(
      'invalid_request',
      `This host speaks controller-succession generation ${PROVIDER_PROXY_CONTROL_GENERATION}, not ${controlGeneration}.`,
    );
  }
}

/**
 * Which build each admitted control holder runs. A role learns a holder's build only at the moment it admits
 * that holder through a redeemed grant, for the build the grant authorized; every other holder was admitted by
 * the bootstrap nonce only the host's own spawner holds, so it runs the host's build. A later install therefore
 * cannot claim a build its holder was never admitted under.
 */
export interface ControllerBuildLedger {
  admit(holder: ControlTenancyHolder, build: ControllerBuild): void;
  buildOf(holder: ControlTenancyHolder | null): ControllerBuild;
}

/** Only the most recent admissions matter: every earlier holder has already been displaced. */
const CONTROLLER_BUILD_LEDGER_CAPACITY = 8;

export function createControllerBuildLedger(hostBuild: ControllerBuild): ControllerBuildLedger {
  const admitted: { holder: ControlTenancyHolder; build: ControllerBuild }[] = [];
  return {
    admit(holder, build) {
      const existing = admitted.findIndex((entry) => sameControlTenancyHolder(entry.holder, holder));
      if (existing !== -1) admitted.splice(existing, 1);
      admitted.push({ holder, build });
      if (admitted.length > CONTROLLER_BUILD_LEDGER_CAPACITY) admitted.shift();
    },
    buildOf(holder) {
      const found =
        holder === null ? undefined : admitted.find((entry) => sameControlTenancyHolder(entry.holder, holder));
      return found?.build ?? hostBuild;
    },
  };
}

/** An installer may only name its own build as the build its recovery grant authorizes. */
export function requireInstallerBuild(
  ledger: ControllerBuildLedger,
  holder: ControlTenancyHolder | null,
  named: ControllerBuild | null,
): ControllerBuild {
  const build = ledger.buildOf(holder);
  if (named !== null && !sameControllerBuild(named, build)) {
    throw new ProxyControlProtocolError(
      'identity_mismatch',
      'The named successor belongs to a different build than the controller installing this grant.',
    );
  }
  return build;
}
