import { z } from 'zod';

import { canonicalUuidSchema, hostFingerprintSchema } from './protocol.js';

export const providerProxySetAddressSchema = z
  .object({
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    proxyInstanceId: canonicalUuidSchema,
  })
  .strict();

export type ProviderProxySetAddress = z.output<typeof providerProxySetAddressSchema>;

const PROVIDER_PROXY_SET_TOKEN_PREFIX = 'pps1.';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeProviderProxySetAddress(input: ProviderProxySetAddress): string {
  const address = providerProxySetAddressSchema.parse(input);
  const canonical = {
    buildSetId: address.buildSetId,
    hostFingerprint: address.hostFingerprint,
    proxyInstanceId: address.proxyInstanceId,
  };
  return `${PROVIDER_PROXY_SET_TOKEN_PREFIX}${Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url')}`;
}

/** Every rejection has one authored operator recovery message; schema diagnostics never cross this boundary. */
export function decodeProviderProxySetAddress(token: string): ProviderProxySetAddress {
  const invalid = (cause?: unknown): Error => {
    const message =
      'provider_proxy_set_token_invalid: copy the exact provider-proxy set token from coral-cli backend status';
    return cause === undefined ? new Error(message) : new Error(message, { cause });
  };
  try {
    if (!token.startsWith(PROVIDER_PROXY_SET_TOKEN_PREFIX)) throw invalid();
    const encoded = token.slice(PROVIDER_PROXY_SET_TOKEN_PREFIX.length);
    if (!BASE64URL_PATTERN.test(encoded)) throw invalid();
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const address = providerProxySetAddressSchema.parse(parsed);
    if (encodeProviderProxySetAddress(address) !== token) throw invalid();
    return address;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('provider_proxy_set_token_invalid:')) throw error;
    throw invalid(error);
  }
}
