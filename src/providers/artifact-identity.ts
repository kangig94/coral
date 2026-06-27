import { createHash } from 'node:crypto';
import { z } from 'zod';

export const providerArtifactIdentitySchema = z
  .object({
    kind: z.string().min(1),
  })
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export type ProviderArtifactIdentity = z.infer<typeof providerArtifactIdentitySchema>;

export function providerArtifactIdentityKey(provider: string, identity: ProviderArtifactIdentity): string {
  return `${provider}:${createHash('sha256').update(canonicalizeIdentity(identity), 'utf8').digest('hex')}`;
}

function canonicalizeIdentity(value: ProviderArtifactIdentity): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}
