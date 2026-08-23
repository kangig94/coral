import { dirname, join } from 'node:path';

import { z } from 'zod';

import { providerHandoffCapsuleFileSuffix, providerHandoffCapsulePath } from '../../infra/path/index.js';
import type { StoragePort } from '../../infra/port-types.js';
import {
  SUPPORTED_HANDOFF_CAPSULE_VERSIONS,
  readHandoffCapsuleFile,
  type HandoffCapsule,
  type HandoffCapsuleFileEnvironment,
} from '../../provider-proxy/handoff-capsule.js';

/**
 * Exactly the generations this build can decode — derived from the decoder's own list rather than restated,
 * so the two cannot disagree.
 *
 * The format generation lives in the filename so a build never opens a capsule it cannot parse: refusing one
 * is a *fatal* startup error, so the only safe way to meet a foreign generation is not to meet it. That has to
 * hold in both directions. Matching `.v<n>` for any n would make this build discover a future `.v4.json`, hand
 * it to a decoder that knows V1 through V3, and abort the boot of the very build someone rolled back to — the
 * failure this mechanism exists to prevent, pointing the other way.
 *
 * Deriving it is what keeps that true across the next change. A V4 that extends the union and forgets this
 * pattern would leave its own capsules undiscoverable; one that extends this pattern and forgets the union
 * would reopen the fatal. Neither is possible while there is one list.
 */
const HANDOFF_CAPSULE_FILENAME = new RegExp(
  `^provider-1[0-9a-f]{23}\\.(?:${[
    ...new Set(SUPPORTED_HANDOFF_CAPSULE_VERSIONS.map((version) => providerHandoffCapsuleFileSuffix(version))),
  ]
    .map((suffix) => suffix.replaceAll('.', '\\.'))
    .join('|')})$`,
  'u',
);

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
  const env: HandoffCapsuleFileEnvironment = { storage: options.storage, uid: options.uid };
  const baseDir = dirname(options.generationRoot);
  const candidates = options.storage
    .readdirSync(options.runDir)
    .filter((entry) => HANDOFF_CAPSULE_FILENAME.test(entry))
    .sort();

  return candidates.map((entry) => {
    const path = join(options.runDir, entry);
    const capsule = readHandoffCapsuleFile(path, env);
    if (capsule === null) throw new Error(`provider_proxy_handoff_capsule_disappeared:${path}`);
    // The capsule's own version, not this build's: an older generation is canonical at the name it shipped
    // under, and holding it to the current one would read every legacy capsule as relocated.
    const canonicalPath = providerHandoffCapsulePath(capsule, capsule.version, { baseDir });
    if (canonicalPath !== path) throw new Error(`provider_proxy_handoff_capsule_path_mismatch:${path}`);
    return Object.freeze({ path, capsule });
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
