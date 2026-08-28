import { z } from 'zod';

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

/**
 * Validates the containment proof boundary. `absent` certifies that recorded-set reaping already completed and
 * alone authorizes downstream disappearance; the other arms authorize neither signalling nor representation
 * release.
 */
export const providerProxySetContainmentProofSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('absent'), receipt: z.string().min(1) }).strict(),
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
 * A validated proof result whose `absent` arm alone may authorize downstream disappearance and claim release.
 */
export type ProviderProxySetContainmentProof = z.output<typeof providerProxySetContainmentProofSchema>;

/**
 * Derives the refusal verdict from the retained role observations. All-absent evidence is rejected because it
 * must continue through recorded-set reaping and return an `absent` receipt instead.
 */
export function providerProxySetEnforcerVerdict(
  observations: ProviderProxySetNonAbsentEnforcerObservations,
): 'enforcer-alive' | 'enforcer-unobservable' {
  if (observations.some(({ observation }) => observation === 'alive')) return 'enforcer-alive';
  return 'enforcer-unobservable';
}
