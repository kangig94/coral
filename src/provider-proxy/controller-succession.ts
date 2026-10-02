import { z } from 'zod';

import { sameControlTenancyHolder, type ControlTenancyHolder } from './control-endpoint.js';
import {
  ProxyControlProtocolError,
  canonicalUuidSchema,
  flavorSchema,
  generationSchema,
  type CoordinatorIdentity,
} from './protocol.js';

/** A successor build must declare the controller-succession contract generation it can accept. */
export const PROVIDER_PROXY_CONTROL_GENERATION = 1;

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

/** The host must already hold the named recovery grant before accepting controller transfer. */
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

export interface ControllerBuildLedger {
  admit(holder: ControlTenancyHolder, build: ControllerBuild): void;
  buildOf(holder: ControlTenancyHolder | null): ControllerBuild;
}

/** A displaced control holder must not retain admission authority. */
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
