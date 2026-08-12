import type { HostRef } from './contract.js';
import { hostRefSchema } from './host-ref-schema.js';

const HOST_REF_TOKEN_PREFIX = 'ph1.';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeHostRef(input: HostRef): string {
  const ref = hostRefSchema.parse(input);
  const canonical =
    ref.leaseMode === 'shared'
      ? {
          provider: ref.provider,
          fingerprint: ref.fingerprint,
          instanceId: ref.instanceId,
          leaseMode: ref.leaseMode,
        }
      : {
          provider: ref.provider,
          fingerprint: ref.fingerprint,
          instanceId: ref.instanceId,
          leaseMode: ref.leaseMode,
          ownerJobId: ref.ownerJobId,
        };
  return `${HOST_REF_TOKEN_PREFIX}${Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url')}`;
}

export function decodeHostRef(token: string): HostRef {
  if (!token.startsWith(HOST_REF_TOKEN_PREFIX)) {
    throw new Error("provider_host_ref_invalid: host reference must start with 'ph1.'");
  }
  const encoded = token.slice(HOST_REF_TOKEN_PREFIX.length);
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new Error('provider_host_ref_invalid: host reference payload must be unpadded base64url');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (error: unknown) {
    throw new Error('provider_host_ref_invalid: host reference payload is not valid UTF-8 JSON', { cause: error });
  }

  const ref = hostRefSchema.parse(parsed);
  if (encodeHostRef(ref) !== token) {
    throw new Error('provider_host_ref_invalid: host reference is not canonically encoded');
  }
  return ref;
}
