import { dirname } from 'node:path';

import { z } from 'zod';

import type { StoragePort } from '../../infra/port-types.js';
import type { HandoffCapsule } from '../../provider-proxy/handoff-capsule.js';
import {
  providerHandoffCapsuleCandidatePaths,
  readProviderHandoffCapsuleCandidate,
} from '../../provider-proxy/handoff-capsule-discovery.js';

export type DiscoveredProviderHandoffCapsule = Readonly<{
  path: string;
  capsule: HandoffCapsule;
}>;

export function discoverProviderHandoffCapsules(
  options: Readonly<{
    runDir: string;
    generationRoot: string;
    storage: StoragePort;
    uid: number;
  }>,
): readonly DiscoveredProviderHandoffCapsule[] {
  const candidates = providerHandoffCapsuleCandidatePaths(options.runDir, options.storage);
  return candidates.map((path) => {
    const candidate = readProviderHandoffCapsuleCandidate(path, options.generationRoot, {
      storage: options.storage,
      uid: options.uid,
    });
    if (candidate.kind === 'invalid') throw new Error(`${candidate.reason}:${path}`);
    return Object.freeze({ path, capsule: candidate.capsule });
  });
}

export type ProviderHandoffCapsuleRetirementOutcome =
  | Readonly<{ kind: 'retired' }>
  | Readonly<{
      kind: 'temporarily-unavailable';
      incident: Readonly<{ kind: 'capsule-directory-durability-unavailable' }>;
    }>;

/**
 * An outcome a consumer may act on, whole. A hold is only as good as the incident it carries, because the
 * consumer reads that incident to decide what it is holding and for how long — so an outcome whose `kind`
 * promises a retry while its `incident` is absent must be rejected here, where the answer is still a
 * disposition, rather than downstream in a sink that has no way left to refuse.
 */
export const providerHandoffCapsuleRetirementOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retired') }).strict(),
  z
    .object({
      kind: z.literal('temporarily-unavailable'),
      incident: z.object({ kind: z.literal('capsule-directory-durability-unavailable') }).strict(),
    })
    .strict(),
]);

export function retireProviderHandoffCapsule(
  storage: Pick<StoragePort, 'syncDirectoryDurableSync' | 'unlinkSync'>,
  path: string,
): ProviderHandoffCapsuleRetirementOutcome {
  try {
    storage.unlinkSync(path);
  } catch (error: unknown) {
    if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') throw error;
  }
  return storage.syncDirectoryDurableSync(dirname(path))
    ? { kind: 'retired' }
    : {
        kind: 'temporarily-unavailable',
        incident: { kind: 'capsule-directory-durability-unavailable' },
      };
}
