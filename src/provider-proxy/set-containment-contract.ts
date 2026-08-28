import { z } from 'zod';

export const PROVIDER_PROXY_SET_LIFECYCLE_STATES = [
  'acquiring',
  'capsule-recovering',
  'capsule-foreign',
  'recovering',
  'available',
  'draining',
  'reattaching',
  'containing',
  'containment-wait',
  'absence-delivery-pending',
  'abandonment-delivery-pending',
] as const;

export type ProviderProxySetLifecycleState = (typeof PROVIDER_PROXY_SET_LIFECYCLE_STATES)[number];

export const providerProxySetEnforcerObservationsSchema = z.tuple([
  z.object({ role: z.literal('guardian'), observation: z.enum(['alive', 'absent', 'unknown']) }).strict(),
  z.object({ role: z.literal('reaper'), observation: z.enum(['alive', 'absent', 'unknown']) }).strict(),
]);

export const providerProxySetAliveEnforcerObservationsSchema = providerProxySetEnforcerObservationsSchema.refine(
  (observations) => observations.some(({ observation }) => observation === 'alive'),
  'An alive containment result must retain at least one alive enforcer observation.',
);

export const providerProxySetUnobservableEnforcerObservationsSchema = providerProxySetEnforcerObservationsSchema.refine(
  (observations) =>
    observations.every(({ observation }) => observation !== 'alive') &&
    observations.some(({ observation }) => observation === 'unknown'),
  'An unobservable containment result must retain unknown evidence and no alive enforcer observation.',
);

export type ProviderProxySetEnforcerObservations = Readonly<
  z.output<typeof providerProxySetEnforcerObservationsSchema>
>;

export const providerProxySetContainmentProofSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent'), receipt: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal('enforcer-alive'), observations: providerProxySetAliveEnforcerObservationsSchema })
    .strict(),
  z
    .object({
      kind: z.literal('enforcer-unobservable'),
      observations: providerProxySetUnobservableEnforcerObservationsSchema,
    })
    .strict(),
  z.object({ kind: z.literal('store-unreadable') }).strict(),
]);

export type ProviderProxySetContainmentProof =
  | Readonly<{ kind: 'absent'; receipt: string }>
  | Readonly<{ kind: 'enforcer-alive'; observations: ProviderProxySetEnforcerObservations }>
  | Readonly<{ kind: 'enforcer-unobservable'; observations: ProviderProxySetEnforcerObservations }>
  | Readonly<{ kind: 'store-unreadable' }>;
