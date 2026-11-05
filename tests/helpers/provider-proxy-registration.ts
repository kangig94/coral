import { expect } from 'vitest';
import type { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';

export function registerProviderProxySetForTest(
  lifecycle: ProviderProxySetLifecycle,
  authority: DurableProviderProxyOperationAuthority,
  receipt: PublicationReceipt,
): void {
  const judgement = lifecycle.acquisitionFor(authority.setIdentity);
  if (judgement.kind !== 'unowned') throw new Error(`Unexpected fixture ownership: ${judgement.kind}`);
  const reservation = judgement.admission.reserve();
  if (reservation.kind !== 'admitted') throw new Error(`Unexpected fixture admission: ${reservation.kind}`);
  expect(lifecycle.registerInheritedSet(authority, receipt, null, 'protected', reservation.token).kind).toBe(
    'accepted',
  );
}
