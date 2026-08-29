import { z } from 'zod';

import { processIncarnationSchema } from '../infra/node-process.js';

const guardianEnforcerObservationSchema = z
  .object({ role: z.literal('guardian'), observation: z.enum(['alive', 'absent', 'unknown']) })
  .strict();
const reaperEnforcerObservationSchema = z
  .object({ role: z.literal('reaper'), observation: z.enum(['alive', 'absent', 'unknown']) })
  .strict();
const guardianAliveObservationSchema = z
  .object({ role: z.literal('guardian'), observation: z.literal('alive') })
  .strict();
const reaperAliveObservationSchema = z.object({ role: z.literal('reaper'), observation: z.literal('alive') }).strict();
const guardianAbsentObservationSchema = z
  .object({ role: z.literal('guardian'), observation: z.literal('absent') })
  .strict();
const reaperAbsentObservationSchema = z
  .object({ role: z.literal('reaper'), observation: z.literal('absent') })
  .strict();
const guardianUnknownObservationSchema = z
  .object({ role: z.literal('guardian'), observation: z.literal('unknown') })
  .strict();
const reaperUnknownObservationSchema = z
  .object({ role: z.literal('reaper'), observation: z.literal('unknown') })
  .strict();

/**
 * Retains the guardian and reaper observations in role order so no caller can substitute an aggregate verdict
 * for the evidence that produced it.
 */
export const providerProxySetEnforcerObservationsSchema = z
  .tuple([guardianEnforcerObservationSchema, reaperEnforcerObservationSchema])
  .readonly();

/** Requires an observed-live enforcer before the wire may report `enforcer-alive`. */
export const providerProxySetAliveEnforcerObservationsSchema = z.union([
  z.tuple([guardianAliveObservationSchema, reaperEnforcerObservationSchema]).readonly(),
  z.tuple([guardianEnforcerObservationSchema, reaperAliveObservationSchema]).readonly(),
]);

/** Requires unknown evidence and excludes observed life before the wire may report `enforcer-unobservable`. */
export const providerProxySetUnobservableEnforcerObservationsSchema = z.union([
  z.tuple([guardianUnknownObservationSchema, reaperAbsentObservationSchema]).readonly(),
  z.tuple([guardianUnknownObservationSchema, reaperUnknownObservationSchema]).readonly(),
  z.tuple([guardianAbsentObservationSchema, reaperUnknownObservationSchema]).readonly(),
]);

/** The complete ordered evidence from the two independent provider-proxy enforcers. */
export type ProviderProxySetEnforcerObservations = z.output<typeof providerProxySetEnforcerObservationsSchema>;

const providerProxySetNonAbsentEnforcerObservationsSchema = z.union([
  providerProxySetAliveEnforcerObservationsSchema,
  providerProxySetUnobservableEnforcerObservationsSchema,
]);
type ProviderProxySetNonAbsentEnforcerObservations = z.output<
  typeof providerProxySetNonAbsentEnforcerObservationsSchema
>;

const recordedProcessIdentityShape = {
  pid: z.number().int().positive().safe(),
  incarnation: processIncarnationSchema,
};
const recordedProcessIdentitySchema = z.object(recordedProcessIdentityShape).strict().readonly();
const recordedContainmentIdentitySchema = z
  .object({ ...recordedProcessIdentityShape, processGroupId: z.number().int().positive().safe() })
  .strict()
  .readonly();

/**
 * Validates the read-only containment-evidence boundary. `reap-required` says both independent enforcers were
 * observed absent and carries the exact recorded targets; it does not certify target absence and authorizes no
 * downstream disappearance unless a recorded-containment owner returns `containment-absent` with a receipt.
 */
export const providerProxySetContainmentEvidenceSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('reap-required'),
        containment: recordedContainmentIdentitySchema,
        recordedRoots: z.array(recordedProcessIdentitySchema).readonly(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('enforcers-observed'),
        observations: providerProxySetNonAbsentEnforcerObservationsSchema,
      })
      .strict(),
    z.object({ kind: z.literal('store-unreadable') }).strict(),
  ])
  .readonly();

/**
 * Read-only evidence gathered before any recorded containment is signalled.
 */
export type ProviderProxySetContainmentEvidence = z.output<typeof providerProxySetContainmentEvidenceSchema>;

/**
 * Derives the refusal verdict from the retained role observations. All-absent evidence is rejected because it
 * must continue through recorded-set reaping; only its `containment-absent` result carries a receipt.
 */
export function providerProxySetEnforcerVerdict(
  observations: ProviderProxySetNonAbsentEnforcerObservations,
): 'enforcer-alive' | 'enforcer-unobservable' {
  if (observations.some(({ observation }) => observation === 'alive')) return 'enforcer-alive';
  return 'enforcer-unobservable';
}
