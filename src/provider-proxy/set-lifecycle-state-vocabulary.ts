/**
 * Transport may not import coordinator modules: the coordinator composes transport, so the reverse import
 * closes the coordinator-transport cycle. Keep their shared lifecycle-state vocabulary below both layers.
 */
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

/** Values crossing coordinator and transport boundaries must belong to this closed vocabulary. */
export type ProviderProxySetLifecycleState = (typeof PROVIDER_PROXY_SET_LIFECYCLE_STATES)[number];
