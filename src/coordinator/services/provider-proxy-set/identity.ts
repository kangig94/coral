import { processIncarnationSchema } from '../../../infra/node-process.js';
import { z } from 'zod';

import {
  canonicalEndpointSchema,
  canonicalUuidSchema,
  hostFingerprintSchema,
} from '../../../provider-proxy/protocol.js';
import type { HandoffCapsule, HandoffCapsuleV3 } from '../../../provider-proxy/handoff-capsule.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import { providerProxySetAddressSchema, type ProviderProxySetAddress } from '../../../provider-proxy/set-address.js';

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

export const providerProxySetIdentitySchema = z
  .object({
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    guardianInstanceId: canonicalUuidSchema,
    guardianPid: nonNegativeSafeIntegerSchema,
    guardianIncarnation: processIncarnationSchema,
    guardianControlEndpoint: canonicalEndpointSchema,
    proxyInstanceId: canonicalUuidSchema,
    proxyPid: nonNegativeSafeIntegerSchema,
    reaperInstanceId: canonicalUuidSchema,
    reaperPid: nonNegativeSafeIntegerSchema,
    reaperIncarnation: processIncarnationSchema,
    reaperControlEndpoint: canonicalEndpointSchema,
    containmentKind: z.string().min(1).max(64),
    proxyIncarnation: processIncarnationSchema,
    proxyProcessGroupId: nonNegativeSafeIntegerSchema,
    canonicalEndpoint: canonicalEndpointSchema,
  })
  .strict();

export type ProviderProxySetIdentity = z.output<typeof providerProxySetIdentitySchema>;
export type ProviderProxySetKey = string & { readonly __providerProxySetKey: unique symbol };

export type ProviderProxySetAddressKey = string & { readonly __providerProxySetAddressKey: unique symbol };

const IDENTITY_FIELDS = [
  'buildSetId',
  'hostFingerprint',
  'guardianInstanceId',
  'guardianPid',
  'guardianIncarnation',
  'guardianControlEndpoint',
  'proxyInstanceId',
  'proxyPid',
  'reaperInstanceId',
  'reaperPid',
  'reaperIncarnation',
  'reaperControlEndpoint',
  'containmentKind',
  'proxyIncarnation',
  'proxyProcessGroupId',
  'canonicalEndpoint',
] as const satisfies readonly (keyof ProviderProxySetIdentity)[];

export function providerProxySetKey(identity: ProviderProxySetIdentity): ProviderProxySetKey {
  const parsed = providerProxySetIdentitySchema.parse(identity);
  return JSON.stringify(IDENTITY_FIELDS.map((field) => parsed[field])) as ProviderProxySetKey;
}

export function providerProxySetIdentitiesEqual(
  left: ProviderProxySetIdentity,
  right: ProviderProxySetIdentity,
): boolean {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

export function providerProxySetReference(identity: ProviderProxySetIdentity): string {
  return `proxyInstanceId=${identity.proxyInstanceId},buildSetId=${identity.buildSetId}`;
}

export function providerProxySetAddress(identity: ProviderProxySetIdentity): ProviderProxySetAddress {
  return Object.freeze({
    buildSetId: identity.buildSetId,
    hostFingerprint: identity.hostFingerprint,
    proxyInstanceId: identity.proxyInstanceId,
  });
}

export function providerProxySetAddressKey(address: ProviderProxySetAddress): ProviderProxySetAddressKey {
  const parsed = providerProxySetAddressSchema.parse(address);
  return JSON.stringify([
    parsed.buildSetId,
    parsed.hostFingerprint,
    parsed.proxyInstanceId,
  ]) as ProviderProxySetAddressKey;
}

export function providerProxySetIdentityFromRecord(
  record: Pick<ProviderOperationRecord, 'operation' | 'locator'>,
): ProviderProxySetIdentity {
  return providerProxySetIdentitySchema.parse({
    buildSetId: record.operation.buildSetId,
    hostFingerprint: record.locator.hostFingerprint,
    guardianInstanceId: record.locator.guardian.instanceId,
    guardianPid: record.locator.guardian.pid,
    guardianIncarnation: record.locator.guardian.incarnation,
    guardianControlEndpoint: record.locator.guardian.controlEndpoint,
    proxyInstanceId: record.operation.proxyInstanceId,
    proxyPid: record.locator.proxy.pid,
    reaperInstanceId: record.locator.reaper.instanceId,
    reaperPid: record.locator.reaper.pid,
    reaperIncarnation: record.locator.reaper.incarnation,
    reaperControlEndpoint: record.locator.reaper.controlEndpoint,
    containmentKind: record.locator.containment.kind,
    proxyIncarnation: record.locator.proxy.incarnation,
    proxyProcessGroupId: record.locator.containment.processGroupId,
    canonicalEndpoint: record.locator.proxy.controlEndpoint,
  });
}

export function providerProxySetIdentityFromCapsule(capsule: HandoffCapsuleV3): ProviderProxySetIdentity {
  return providerProxySetIdentitySchema.parse({
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    guardianInstanceId: capsule.guardianInstanceId,
    guardianPid: capsule.guardianPid,
    guardianIncarnation: capsule.guardianIncarnation,
    guardianControlEndpoint: capsule.guardianControlEndpoint,
    proxyInstanceId: capsule.proxyInstanceId,
    proxyPid: capsule.proxyPid,
    reaperInstanceId: capsule.reaperInstanceId,
    reaperPid: capsule.reaperPid,
    reaperIncarnation: capsule.reaperIncarnation,
    reaperControlEndpoint: capsule.reaperControlEndpoint,
    containmentKind: capsule.containmentKind,
    proxyIncarnation: capsule.proxyIncarnation,
    proxyProcessGroupId: capsule.proxyProcessGroupId,
    canonicalEndpoint: capsule.proxyEndpoint,
  });
}

/**
 * V3 alone carries a comparable process identity, so only it is compared in full. V1 has none, and V2's is
 * seconds from a retired derivation — comparing those against a token would manufacture a disagreement
 * rather than find one, so both are held to the fields that mean the same thing in every version.
 */
export function providerProxySetCapsuleMatchesIdentity(
  capsule: HandoffCapsule,
  identity: ProviderProxySetIdentity,
): boolean {
  if (capsule.version === 3) {
    return providerProxySetIdentitiesEqual(providerProxySetIdentityFromCapsule(capsule), identity);
  }
  return (
    capsule.buildSetId === identity.buildSetId &&
    capsule.hostFingerprint === identity.hostFingerprint &&
    capsule.guardianInstanceId === identity.guardianInstanceId &&
    capsule.reaperInstanceId === identity.reaperInstanceId &&
    capsule.proxyInstanceId === identity.proxyInstanceId &&
    capsule.guardianControlEndpoint === identity.guardianControlEndpoint &&
    capsule.reaperControlEndpoint === identity.reaperControlEndpoint &&
    capsule.proxyEndpoint === identity.canonicalEndpoint
  );
}

export class ProviderProxySetIdentityIndex {
  readonly #identities = new Map<ProviderProxySetKey, ProviderProxySetIdentity>();
  readonly #addressIndex = new Map<ProviderProxySetAddressKey, ProviderProxySetKey>();

  add(identity: ProviderProxySetIdentity): ProviderProxySetKey {
    const parsed = providerProxySetIdentitySchema.parse(identity);
    const key = providerProxySetKey(parsed);
    const addressKey = providerProxySetAddressKey(providerProxySetAddress(parsed));
    const indexedKey = this.#addressIndex.get(addressKey);
    if (indexedKey !== undefined && indexedKey !== key) {
      throw new Error(`provider_proxy_set_identity_alias: address ${addressKey} names two complete identities`);
    }
    const existing = this.#identities.get(key);
    if (existing !== undefined && !providerProxySetIdentitiesEqual(existing, parsed)) {
      throw new Error('provider_proxy_set_key_collision: canonical serialization names two complete identities');
    }
    this.#identities.set(key, parsed);
    this.#addressIndex.set(addressKey, key);
    return key;
  }

  delete(identity: ProviderProxySetIdentity): void {
    const key = providerProxySetKey(identity);
    if (!this.#identities.delete(key)) return;
    const addressKey = providerProxySetAddressKey(providerProxySetAddress(identity));
    if (this.#addressIndex.get(addressKey) === key) this.#addressIndex.delete(addressKey);
  }

  keyForAddress(address: ProviderProxySetAddress): ProviderProxySetKey | null {
    return this.#addressIndex.get(providerProxySetAddressKey(address)) ?? null;
  }

  identityForKey(key: ProviderProxySetKey): ProviderProxySetIdentity | null {
    return this.#identities.get(key) ?? null;
  }

  get size(): number {
    return this.#identities.size;
  }
}
